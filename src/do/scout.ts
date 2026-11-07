import { DurableObject } from "cloudflare:workers";
import { db, getConfig, setConfig } from "../db/repo";
import type { Env } from "../env";
import { type AvailabilityStatus, InflowError, InflowSession, type LotKey } from "../inflow/client";
import { CognitoError, jwtClaims, login, refresh } from "../inflow/cognito";
import { alertAdmin } from "../telegram";

type Month = Record<string, { availabilityStatus: AvailabilityStatus }>;

interface Tokens {
  refreshToken?: string;
  idToken?: string;
  idTokenExp?: number;
}

const MIN_SPACING_MS = 250;
const PROBE_EVERY_MS = 5 * 60_000;

/**
 * Singleton. Owns the scout Inflow account and does every availability read, with a global
 * request spacing, a short cache for the /watch calendar UI, and health reporting.
 */
export class ScoutSession extends DurableObject<Env> {
  private cache = new Map<string, { at: number; data: Month }>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  /** null = unknown since (re)start; read from D1 on first use. */
  private healthy: boolean | null = null;
  private lastProbeAt = 0;

  private async idToken(force = false): Promise<string> {
    const t = (await this.ctx.storage.get<Tokens>("tokens")) ?? {};
    const nowS = Date.now() / 1000;
    if (!force && t.idToken && (t.idTokenExp ?? 0) - 3600 > nowS) return t.idToken;
    let next: Tokens;
    try {
      if (!t.refreshToken) throw new Error("no refresh token");
      const r = await refresh(t.refreshToken);
      next = { ...t, idToken: r.idToken, idTokenExp: Number(jwtClaims(r.idToken).exp) };
    } catch {
      const r = await login(this.env.SCOUT_EMAIL, this.env.SCOUT_PASSWORD);
      next = { refreshToken: r.refreshToken, idToken: r.idToken, idTokenExp: Number(jwtClaims(r.idToken).exp) };
    }
    await this.ctx.storage.put("tokens", next);
    return next.idToken!;
  }

  private async session(lot: LotKey, fresh = false): Promise<{ s: InflowSession; calendarId: string }> {
    const key = `sess:${lot}`;
    let rec = fresh ? undefined : await this.ctx.storage.get<{ token: string; calendarId: string }>(key);
    if (!rec) {
      const token = await InflowSession.welcome(lot);
      const s = new InflowSession(lot, token, () => this.idToken());
      const { calendars } = await s.calendars();
      const calendarId = calendars[0]?.bookingCalendarID;
      if (!calendarId) throw new InflowError("/calendars", 200, "NoCalendar", calendars);
      rec = { token, calendarId };
      await this.ctx.storage.put(key, rec);
    }
    return { s: new InflowSession(lot, rec.token, () => this.idToken()), calendarId: rec.calendarId };
  }

  /** Serialize + space out requests to Inflow across all callers. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastRequestAt + MIN_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async availability(lot: LotKey, month: string, maxAgeMs = 0): Promise<Month> {
    const ck = `${lot}:${month}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at <= maxAgeMs) return hit.data;
    if (this.healthy === null) this.healthy = (await getConfig(db(this.env.DB), "scout_status")) !== "degraded";
    // while degraded, let one probe through every 5 minutes so we self-heal
    if (!this.healthy) {
      if (Date.now() - this.lastProbeAt < PROBE_EVERY_MS) throw new Error("ScoutDegraded");
      this.lastProbeAt = Date.now();
    }
    return this.throttled(async () => {
      let attempt = 0;
      for (;;) {
        try {
          const { s, calendarId } = await this.session(lot, attempt > 0);
          const res = await s.calendarAvailability(calendarId, month);
          if (!res || typeof res.availability !== "object") {
            throw new InflowError("/calendar-availability", 200, "SchemaMismatch", res);
          }
          this.cache.set(ck, { at: Date.now(), data: res.availability });
          await this.markHealthy();
          return res.availability;
        } catch (e) {
          const retriable =
            attempt === 0 &&
            e instanceof InflowError &&
            (e.status === 401 || e.failReason === "CognitoTokenExpired" || e.failReason === "BookingCalendarIDMismatch");
          if (retriable) {
            if (e.failReason === "CognitoTokenExpired") await this.idToken(true);
            attempt++;
            continue;
          }
          await this.markUnhealthy(e);
          throw e;
        }
      }
    });
  }

  async health() {
    const t = (await this.ctx.storage.get<Tokens>("tokens")) ?? {};
    return { healthy: this.healthy !== false, idTokenExp: t.idTokenExp ?? null };
  }

  /** Admin: force re-login (e.g. after rotating SCOUT_PASSWORD). */
  async relogin() {
    await this.ctx.storage.delete("tokens");
    await this.idToken(true);
    await this.markHealthy();
    return this.health();
  }

  private async markHealthy() {
    if (this.healthy === true) return;
    this.healthy = true;
    const d = db(this.env.DB);
    if ((await getConfig(d, "scout_status")) === "degraded") {
      await setConfig(d, "scout_status", "ok");
      await alertAdmin(this.env, "scout-recovered", "Scout account is healthy again; polling resumed.");
    }
  }

  private async markUnhealthy(e: unknown) {
    const authish = e instanceof CognitoError || (e instanceof InflowError && (e.status === 401 || e.status === 403));
    const schema = e instanceof InflowError && e.failReason === "SchemaMismatch";
    // transient network/5xx errors don't degrade the scout; auth and schema problems do
    if (!authish && !schema) return;
    this.healthy = false;
    this.lastProbeAt = Date.now();
    await setConfig(db(this.env.DB), "scout_status", "degraded");
    await alertAdmin(
      this.env,
      schema ? "inflow-schema" : "scout-auth",
      `Scout ${schema ? "got an unexpected response shape" : "auth failed"}: ${String((e as Error).message).slice(0, 300)}\nPolling paused (auto-retry every 5 min). /admin → Scout to re-login.`,
    );
  }
}
