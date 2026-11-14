import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { attemptBooking, type BookingOutcome, type Handoff, pollConfirm } from "../core/booking";
import { USER_REASON_TEXT } from "../core/classify";
import { canChangePlate, plateUpdateError } from "../core/plates";
import { decrypt, encrypt, randomId } from "../core/crypto";
import { prettyDate } from "../core/time";
import { db, getUser, getWatch, logEvent, now, prefsOf, transitionWatch } from "../db/repo";
import { bookings, users, watches } from "../db/schema";
import type { Env } from "../env";
import { InflowError, InflowSession, type InflowUser, LOTS, type LotKey, sessionClaims } from "../inflow/client";
import { CognitoError, jwtClaims, login, refresh } from "../inflow/cognito";
import { findPublishableKey } from "../inflow/stripe";
import { esc, send } from "../telegram";

interface Creds {
  tgUserId: number;
  email: string;
  encPassword: string;
  refreshToken?: string;
  idToken?: string;
  idTokenExp?: number;
}

interface Pending extends Handoff {
  payToken: string;
  watchId: string;
  lot: LotKey;
  date: string;
  amount: number;
  rateName: string;
  plate: string;
}

export interface Reservation {
  reservationID: string;
  lot: LotKey;
  date: string;
  plate: string;
  confirmationNumber: string;
  cancellationDeadline: string;
  blockCancellation: boolean;
  locationID: string;
  enterpriseID: string;
  rateName: string;
  /** Latest receipt; `/plate-update` needs it. */
  receiptID: string;
  allowPlateChangeUntil: string | null;
}

export type PlatesResult = { ok: true; plates: { plate: string; nickname: string }[] } | { ok: false; error: string };

export type AttemptResult = { kind: "skipped"; why: string } | BookingOutcome;

/** Lots with distinct Inflow locations (Solitude & Nordic share one). */
const LOCATION_LOTS: LotKey[] = ["alta", "brighton", "solitude"];
const LOST_NOTIFY_EVERY_MS = 30 * 60_000;

/** One per Telegram user. Holds their Inflow credentials and serializes all their Inflow calls. */
export class AccountAgent extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---------- auth ----------

  private async creds(): Promise<Creds | undefined> {
    return this.ctx.storage.get<Creds>("creds");
  }

  private async idToken(force = false): Promise<string> {
    const c = await this.creds();
    if (!c) throw new CognitoError("NotConnected", "no Inflow credentials", 0);
    const nowS = Date.now() / 1000;
    if (!force && c.idToken && (c.idTokenExp ?? 0) - 3600 > nowS) return c.idToken;
    try {
      if (!c.refreshToken) throw new Error("no refresh token");
      const r = await refresh(c.refreshToken);
      await this.ctx.storage.put("creds", { ...c, idToken: r.idToken, idTokenExp: Number(jwtClaims(r.idToken).exp) });
      return r.idToken;
    } catch {
      const password = await decrypt(this.env.CREDS_ENC_KEY, c.encPassword, String(c.tgUserId));
      const r = await login(c.email, password);
      await this.ctx.storage.put("creds", {
        ...c,
        refreshToken: r.refreshToken,
        idToken: r.idToken,
        idTokenExp: Number(jwtClaims(r.idToken).exp),
      });
      return r.idToken;
    }
  }

  /** Verify credentials, store them, and return the account's saved plates. */
  async connectInflow(tgUserId: number, email: string, password: string) {
    return this.serial(async () => {
      let t;
      try {
        t = await login(email, password);
      } catch (e) {
        if (e instanceof CognitoError && ["NotAuthorizedException", "UserNotFoundException"].includes(e.type)) {
          return { ok: false as const, error: "Wrong email or password." };
        }
        throw e;
      }
      await this.ctx.storage.put<Creds>("creds", {
        tgUserId,
        email,
        encPassword: await encrypt(this.env.CREDS_ENC_KEY, password, String(tgUserId)),
        refreshToken: t.refreshToken,
        idToken: t.idToken,
        idTokenExp: Number(jwtClaims(t.idToken).exp),
      });
      const profile = await this.profileUnlocked();
      return { ok: true as const, ...profile };
    });
  }

  private async gatedSession() {
    return new InflowSession("alta", await InflowSession.welcome("alta"), () => this.idToken());
  }

  private static platesOf(a: InflowUser) {
    return (a.savedPlates ?? []).map((p) => ({ plate: p.plate, nickname: p.nickname ?? "" }));
  }

  private async profileUnlocked() {
    const a = await (await this.gatedSession()).account();
    return { firstName: a.first ?? "", plates: AccountAgent.platesOf(a) };
  }

  async profile() {
    return this.serial(() => this.profileUnlocked());
  }

  /**
   * Edit the saved plates on the Inflow account. Inflow only accepts a whole user record, so this re-reads
   * `/account` and sends it back unchanged apart from `savedPlates`. Nothing is stored on our side.
   */
  private editPlates(edit: (plates: NonNullable<InflowUser["savedPlates"]>) => NonNullable<InflowUser["savedPlates"]>) {
    return this.serial(async (): Promise<PlatesResult> => {
      const s = await this.gatedSession();
      const user = await s.account();
      const next = edit(user.savedPlates ?? []);
      try {
        await s.updateAppUser({ ...user, savedPlates: next });
      } catch (e) {
        console.error(JSON.stringify({ event: "appuser_put_failed", error: String(e) }));
        return { ok: false, error: `Inflow didn't save it (${e instanceof InflowError ? (e.failReason ?? e.status) : "no response"}).` };
      }
      return { ok: true, plates: AccountAgent.platesOf({ savedPlates: next }) };
    });
  }

  addPlate(plate: string) {
    return this.editPlates((ps) =>
      ps.some((p) => p.plate === plate) ? ps : [...ps, { plate, nickname: "", state: "XX", lastUsed: new Date().toISOString() }],
    );
  }

  removePlate(plate: string) {
    return this.editPlates((ps) => ps.filter((p) => p.plate !== plate));
  }

  async health() {
    const c = await this.creds();
    const pending = await this.ctx.storage.get<Pending>("pending");
    return {
      connected: Boolean(c),
      email: c?.email ?? null,
      idTokenExp: c?.idTokenExp ?? null,
      pendingPayment: pending ? { lot: pending.lot, date: pending.date, holdUntil: pending.holdUntil } : null,
    };
  }

  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---------- booking ----------

  async attempt(watchId: string, { manual = false } = {}): Promise<AttemptResult> {
    return this.serial(async () => {
      const d = db(this.env.DB);
      const pending = await this.ctx.storage.get<Pending>("pending");
      if (pending && pending.holdUntil > Date.now()) return { kind: "skipped", why: "payment pending" } as const;

      const watch = await getWatch(d, watchId);
      if (!watch) return { kind: "skipped", why: "no watch" } as const;
      const user = await getUser(d, watch.tgUserId);
      if (!user || user.status !== "active") return { kind: "skipped", why: "user inactive" } as const;
      if (!(await transitionWatch(d, watchId, manual ? ["active", "paused"] : ["active"], "booking"))) {
        return { kind: "skipped", why: "watch not active" } as const;
      }

      const lot = watch.lot as LotKey;
      const plate = watch.plateOverride ?? user.defaultPlate;
      const prefs = prefsOf(user);
      let outcome: BookingOutcome;
      if (!plate) {
        outcome = { kind: "paused", reason: "NoSavedPlate" };
      } else {
        const req = {
          lot,
          date: watch.date,
          plate,
          email: user.inflowEmail ?? (await this.creds())?.email ?? "",
          carpool: watch.carpoolOverride != null ? Boolean(watch.carpoolOverride) : Boolean(prefs.carpool?.[lot]),
          accessKey: prefs.accessKeys?.[lot],
        };
        const t0 = Date.now();
        let force = false;
        const deps = {
          getIdToken: () => {
            const f = force; // force a refresh once on the retry, not on every call
            force = false;
            return this.idToken(f);
          },
          log: (step: string, detail?: unknown) =>
            console.log(JSON.stringify({ event: "booking_step", watchId, step, detail, ms: Date.now() - t0 })),
        };
        outcome = await attemptBooking(req, deps).catch((e) => ({ kind: "auth", reason: String(e) }) as BookingOutcome);
        if (outcome.kind === "auth") {
          force = true;
          outcome = await attemptBooking(req, deps).catch(
            (e) => ({ kind: "auth", reason: e instanceof CognitoError ? e.type : String(e) }) as BookingOutcome,
          );
        }
        await logEvent(d, "attempt", { outcome: outcome.kind, reason: "reason" in outcome ? outcome.reason : undefined, ms: Date.now() - t0 }, { tgUserId: user.tgUserId, watchId });
      }
      await this.handleOutcome(outcome, { watchId, lot, date: watch.date, chatId: user.chatId, tgUserId: user.tgUserId, manual });
      return outcome;
    });
  }

  private async handleOutcome(
    o: BookingOutcome,
    ctx: { watchId: string; lot: LotKey; date: string; chatId: number; tgUserId: number; manual: boolean },
  ) {
    const d = db(this.env.DB);
    const where = `<b>${LOTS[ctx.lot].name}</b> · ${prettyDate(ctx.date)}`;
    switch (o.kind) {
      case "booked":
        return this.recordBooked({ ...ctx, receiptID: o.receiptID, amount: o.amount, rateName: o.rateName, plate: o.plate, sessionToken: o.sessionToken });

      case "handoff": {
        const p: Pending = { ...o, payToken: randomId(20), watchId: ctx.watchId, lot: ctx.lot, date: ctx.date };
        await this.ctx.storage.put("pending", p);
        await this.ctx.storage.setAlarm(o.holdUntil + 15_000);
        const mins = Math.max(1, Math.round((o.holdUntil - Date.now()) / 60_000));
        const why = o.reason === "3DS" ? "Your bank wants to verify this payment." : "I couldn't pay automatically.";
        await send(this.env, ctx.chatId, `⏳ Holding ${where} · $${o.amount}\n${why} Pay within ~${mins} min to keep it.`, {
          keyboard: [[{ text: "💳 Pay now", web_app: { url: `${this.env.PUBLIC_URL}/miniapp/pay?t=${p.payToken}` } }]],
        });
        return;
      }

      case "lost": {
        await transitionWatch(d, ctx.watchId, ["booking"], "active");
        const key = `lostAt:${ctx.watchId}`;
        const last = (await this.ctx.storage.get<number>(key)) ?? 0;
        if (ctx.manual || Date.now() - last > LOST_NOTIFY_EVERY_MS) {
          await this.ctx.storage.put(key, Date.now());
          const text =
            o.reason === "NoRateAvailable" || o.reason === "ReservationCapacityReached"
              ? `🏃 Missed a spot at ${where} — someone was faster. Still watching.`
              : `⚠️ Booking attempt at ${where} failed (${esc(o.reason)}). Still watching.`;
          await send(this.env, ctx.chatId, text, { silent: true });
        }
        return;
      }

      case "paused": {
        await transitionWatch(d, ctx.watchId, ["booking"], "paused", { pauseReason: o.reason });
        await send(this.env, ctx.chatId, `⏸ Paused ${where}: ${esc(USER_REASON_TEXT[o.reason] ?? o.reason)}.`, {
          keyboard: [[{ text: "▶️ Resume", callback_data: `wr:${ctx.watchId}` }]],
        });
        return;
      }

      case "auth": {
        await transitionWatch(d, ctx.watchId, ["booking"], "active");
        await d.update(users).set({ status: "needs_login", updatedAt: now() }).where(eq(users.tgUserId, ctx.tgUserId));
        await send(this.env, ctx.chatId, "🔐 Your Inflow login stopped working, so your watches are paused. Log in again to resume.", {
          keyboard: [[{ text: "🔐 Log in to Inflow", web_app: { url: `${this.env.PUBLIC_URL}/miniapp/login` } }]],
        });
        return;
      }
    }
  }

  private async recordBooked(b: {
    watchId: string;
    lot: LotKey;
    date: string;
    chatId: number;
    tgUserId: number;
    receiptID: string;
    amount: number;
    rateName: string;
    plate: string;
    sessionToken: string;
  }) {
    const d = db(this.env.DB);
    await d
      .update(watches)
      .set({ status: "booked", updatedAt: now(), pauseReason: null })
      .where(and(eq(watches.id, b.watchId), inArray(watches.status, ["booking", "active", "paused"])));
    let res: Reservation | undefined;
    try {
      res = (await this.reservationsUnlocked()).find((r) => r.date === b.date && r.lot === b.lot);
    } catch (e) {
      console.error(JSON.stringify({ event: "reservation_lookup_failed", error: String(e) }));
    }
    await d.insert(bookings).values({
      id: randomId(),
      watchId: b.watchId,
      tgUserId: b.tgUserId,
      lot: b.lot,
      date: b.date,
      inflowReservationId: res?.reservationID ?? null,
      confirmationNumber: res?.confirmationNumber ?? null,
      receiptId: b.receiptID,
      rateName: b.rateName,
      amount: b.amount,
      plate: b.plate,
      createdAt: now(),
    });
    await logEvent(d, "booked", { lot: b.lot, date: b.date, amount: b.amount }, { tgUserId: b.tgUserId, watchId: b.watchId });
    await send(
      this.env,
      b.chatId,
      `🎉 Booked <b>${LOTS[b.lot].name}</b> · ${prettyDate(b.date)} · $${b.amount} · ${esc(b.plate)}` +
        (res ? `\nConfirmation <code>${esc(res.confirmationNumber)}</code> · free cancel until 8:00am` : ""),
      {
        keyboard: res
          ? [[{ text: "🚘 Change plate", callback_data: `bpa:${res.reservationID}` }, { text: "❌ Cancel", callback_data: `bx:${res.reservationID}` }]]
          : undefined,
      },
    );
  }

  // ---------- payment handoff (Mini App) ----------

  async paymentInfo(payToken: string) {
    const p = await this.ctx.storage.get<Pending>("pending");
    if (!p || p.payToken !== payToken || p.holdUntil < Date.now()) return null;
    return {
      publishableKey: await findPublishableKey(),
      clientSecret: p.clientSecret,
      customerSessionClientSecret: p.customerSessionClientSecret ?? null,
      setup: p.setup,
      amount: p.amount,
      holdUntil: p.holdUntil,
      label: `${LOTS[p.lot].name} · ${prettyDate(p.date)} · ${p.rateName}`,
    };
  }

  /** Called by the Mini App after Stripe confirmed client-side. */
  async paid(payToken: string) {
    return this.serial(async () => {
      const p = await this.ctx.storage.get<Pending>("pending");
      if (!p || p.payToken !== payToken) return { ok: false };
      return { ok: await this.finishPending(p) };
    });
  }

  private async finishPending(p: Pending): Promise<boolean> {
    const s = new InflowSession(p.lot, p.sessionToken, () => this.idToken());
    let receiptID: string | null = null;
    try {
      receiptID = await pollConfirm(s, p.setup, (ms) => new Promise((r) => setTimeout(r, ms)), 5);
    } catch {
      const st = await s.sessionStatus().catch(() => null);
      receiptID = st?.status === "Complete" ? ((st.receiptID as string) ?? "unknown") : null;
    }
    if (!receiptID) return false;
    await this.ctx.storage.delete("pending");
    await this.ctx.storage.deleteAlarm();
    const watch = await getWatch(db(this.env.DB), p.watchId);
    const user = watch && (await getUser(db(this.env.DB), watch.tgUserId));
    if (!watch || !user) return true;
    await this.recordBooked({ ...p, chatId: user.chatId, tgUserId: user.tgUserId, receiptID, sessionToken: p.sessionToken });
    return true;
  }

  /** Fires after a handed-off hold should have expired. */
  async alarm() {
    await this.serial(async () => {
      const p = await this.ctx.storage.get<Pending>("pending");
      if (!p) return;
      if (await this.finishPending(p)) return;
      await this.ctx.storage.delete("pending");
      const d = db(this.env.DB);
      await transitionWatch(d, p.watchId, ["booking"], "active");
      const watch = await getWatch(d, p.watchId);
      const user = watch && (await getUser(d, watch.tgUserId));
      if (user) {
        await send(this.env, user.chatId, `⌛ Hold on <b>${LOTS[p.lot].name}</b> · ${prettyDate(p.date)} expired. Still watching.`, {
          silent: true,
        });
      }
    });
  }

  // ---------- reservations ----------

  private async reservationsUnlocked(): Promise<Reservation[]> {
    const seen = new Map<string, Reservation>();
    await Promise.all(
      LOCATION_LOTS.map(async (lot) => {
        const s = new InflowSession(lot, await InflowSession.welcome(lot), () => this.idToken());
        const locationID = String(sessionClaims(s.sessionToken).locationID);
        const { reservations } = await s.currentReservations(locationID);
        for (const r of reservations ?? []) {
          if (r.status !== "Active") continue;
          const cal = String(r.bookingCalendarName ?? "");
          const rlot: LotKey = lot === "solitude" && /nordic/i.test(cal) ? "solitude-nordic" : lot;
          const tz = String(r.locationTimezone ?? "America/Denver");
          const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(String(r.startDateTime)));
          seen.set(String(r.reservationID), {
            reservationID: String(r.reservationID),
            lot: rlot,
            date,
            plate: String(r.plate ?? ""),
            confirmationNumber: String(r.confirmationNumber ?? ""),
            cancellationDeadline: String(r.cancellationDeadline ?? ""),
            blockCancellation: Boolean(r.blockCancellation),
            locationID: String(r.locationID ?? locationID),
            enterpriseID: String(r.enterpriseID ?? "IPCCO"),
            rateName: String(r.inventoryTreeRateName ?? ""),
            receiptID: String((r.receiptIDs as string[] | undefined)?.at(-1) ?? ""),
            allowPlateChangeUntil: r.allowPlateChangeUntil ? String(r.allowPlateChangeUntil) : null,
          });
        }
      }),
    );
    return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async reservations() {
    return this.serial(() => this.reservationsUnlocked());
  }

  async cancel(reservationID: string) {
    return this.serial(async () => {
      const r = (await this.reservationsUnlocked()).find((x) => x.reservationID === reservationID);
      if (!r) return { ok: false as const, error: "Reservation not found (already cancelled?)" };
      if (r.blockCancellation) return { ok: false as const, error: "Inflow no longer allows cancelling this one." };
      const lot = r.lot === "solitude-nordic" ? "solitude" : r.lot;
      const s = new InflowSession(lot, await InflowSession.welcome(lot), () => this.idToken());
      await s.cancelReservation({ reservationID, locationID: r.locationID, enterpriseID: r.enterpriseID });
      await db(this.env.DB).update(bookings).set({ status: "cancelled" }).where(eq(bookings.inflowReservationId, reservationID));
      return { ok: true as const, reservation: r };
    });
  }

  /** Change the plate on one of this user's active reservations. */
  async changePlate(reservationID: string, newPlate: string) {
    return this.serial(async () => {
      const r = (await this.reservationsUnlocked()).find((x) => x.reservationID === reservationID);
      if (!r) return { ok: false as const, error: "Reservation not found (cancelled?)" };
      if (r.plate === newPlate) return { ok: true as const, reservation: r };
      if (!canChangePlate(r)) return { ok: false as const, error: plateUpdateError("WindowClosed", newPlate), reservation: r };
      if (!r.receiptID) return { ok: false as const, error: "Inflow didn't return a receipt for this reservation.", reservation: r };
      const lot = r.lot === "solitude-nordic" ? "solitude" : r.lot;
      const s = new InflowSession(lot, await InflowSession.welcome(lot), () => this.idToken());
      try {
        await s.plateUpdate({ newPlate, reservationID, receiptID: r.receiptID });
      } catch (e) {
        console.error(JSON.stringify({ event: "plate_update_failed", error: String(e) }));
        return { ok: false as const, error: plateUpdateError(e instanceof InflowError ? e.failReason : undefined, newPlate), reservation: r };
      }
      await db(this.env.DB).update(bookings).set({ plate: newPlate }).where(eq(bookings.inflowReservationId, reservationID));
      return { ok: true as const, reservation: { ...r, plate: newPlate } };
    });
  }
}
