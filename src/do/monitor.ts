import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { nextPollDelay } from "../core/cadence";
import { prettyDate, watchDeadline } from "../core/time";
import { activeWatchesFor, db, getConfig, getWindows, logEvent } from "../db/repo";
import { watches } from "../db/schema";
import { account, type Env, scout } from "../env";
import { LOTS, type LotKey } from "../inflow/client";
import { send } from "../telegram";

interface MonitorState {
  lot: LotKey;
  date: string;
  lastStatus?: string;
  lastPollAt?: number;
  nextAt?: number;
}

/** Re-attempt the same watch at most this often while a date stays "Available". */
const ATTEMPT_COOLDOWN_MS = 30_000;

/**
 * One per (lot, date) that has active watches. Polls availability through the scout on an
 * adaptive cadence and fans out to every watcher's AccountAgent in parallel when a spot opens.
 */
export class LotDateMonitor extends DurableObject<Env> {
  private lastAttempt = new Map<string, number>();

  /** Idempotent: start polling if not already scheduled. */
  async ensure(lot: LotKey, date: string, { soon = false } = {}) {
    const st = (await this.ctx.storage.get<MonitorState>("state")) ?? { lot, date };
    await this.ctx.storage.put("state", { ...st, lot, date });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || (soon && alarm > Date.now() + 2_000)) {
      await this.ctx.storage.setAlarm(Date.now() + (soon ? 500 : 1_000));
    }
  }

  async info(): Promise<MonitorState | null> {
    return (await this.ctx.storage.get<MonitorState>("state")) ?? null;
  }

  async alarm() {
    const st = await this.ctx.storage.get<MonitorState>("state");
    if (!st) return;
    const d = db(this.env.DB);
    const now = Date.now();

    if (now >= watchDeadline(st.date)) {
      await this.expireAll(st);
      await this.ctx.storage.deleteAll();
      return;
    }

    const active = await activeWatchesFor(d, st.lot, st.date);
    if (active.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }

    let status = st.lastStatus;
    if ((await getConfig(d, "kill_switch")) !== "1") {
      try {
        const month = await scout(this.env).availability(st.lot, st.date.slice(0, 7));
        status = month[st.date]?.availabilityStatus ?? "Unknown";
      } catch (e) {
        console.log(JSON.stringify({ event: "poll_failed", lot: st.lot, date: st.date, error: String(e) }));
        status = st.lastStatus;
      }

      if (status === "Available") {
        await this.fire(st, active, st.lastStatus !== "Available");
      }
    }

    const windows = await getWindows(d, st.lot);
    const delay = nextPollDelay({ now: Date.now(), date: st.date, windows, lastStatus: status });
    const nextAt = Date.now() + delay;
    await this.ctx.storage.put("state", { ...st, lastStatus: status, lastPollAt: now, nextAt });
    await this.ctx.storage.setAlarm(nextAt);
  }

  private async fire(st: MonitorState, active: Awaited<ReturnType<typeof activeWatchesFor>>, transitioned: boolean) {
    const now = Date.now();
    const lotName = LOTS[st.lot].name;
    const jobs = active.map(async ({ watch, user }) => {
      if (watch.mode === "notify") {
        if (!transitioned) return;
        await send(this.env, user.chatId, `👀 Spot open: <b>${lotName}</b> · ${prettyDate(st.date)}`, {
          keyboard: [[{ text: "⚡ Book now", callback_data: `bn:${watch.id}` }]],
        });
        return;
      }
      const last = this.lastAttempt.get(watch.id) ?? 0;
      if (!transitioned && now - last < ATTEMPT_COOLDOWN_MS) return;
      this.lastAttempt.set(watch.id, now);
      await account(this.env, user.tgUserId).attempt(watch.id);
    });
    const results = await Promise.allSettled(jobs);
    await logEvent(db(this.env.DB), "spot_open", {
      lot: st.lot,
      date: st.date,
      watchers: active.length,
      failed: results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)),
    });
  }

  private async expireAll(st: MonitorState) {
    const d = db(this.env.DB);
    await d
      .update(watches)
      .set({ status: "expired", updatedAt: Date.now() })
      .where(and(eq(watches.lot, st.lot), eq(watches.date, st.date), inArray(watches.status, ["active", "paused"])));
  }
}
