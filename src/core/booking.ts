/**
 * One booking attempt for one (lot, date), as proven by the spike:
 * welcome → [apply-code] → calendars → calendar-availability → calendar-rates → select-rate (10-min hold)
 * → plate → checkout → payment-intent → (free: confirm) | (paid: Stripe confirm w/ saved card → confirm)
 * Pure w.r.t. storage: the caller (AccountAgent) persists outcomes.
 */
import { InflowError, InflowSession, type LotKey } from "../inflow/client";
import { confirmWithSavedCard, findPublishableKey, listSavedCards } from "../inflow/stripe";
import { classify } from "./classify";
import { chooseRate } from "./rates";

export interface BookingRequest {
  lot: LotKey;
  date: string;
  plate: string;
  email: string;
  carpool: boolean;
  accessKey?: string;
}

export interface BookingDeps {
  getIdToken: () => Promise<string>;
  fetch?: typeof fetch;
  publishableKey?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (step: string, detail?: unknown) => void;
}

export interface Handoff {
  sessionToken: string;
  clientSecret: string;
  customerSessionClientSecret?: string;
  setup: boolean;
  holdUntil: number;
  reason: string;
}

export type BookingOutcome =
  | { kind: "booked"; receiptID: string; amount: number; rateName: string; plate: string; sessionToken: string }
  | ({ kind: "handoff"; amount: number; rateName: string; plate: string } & Handoff)
  | { kind: "lost"; reason: string }
  | { kind: "paused"; reason: string }
  | { kind: "auth"; reason: string };

const WEBHOOK_PENDING = /WebhookNotCompleted/;

export async function pollConfirm(
  s: InflowSession,
  setup: boolean,
  sleep: (ms: number) => Promise<void>,
  tries = 10,
): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await s.confirmPayment(setup);
      if (r.receiptID) return r.receiptID;
    } catch (e) {
      if (!(e instanceof InflowError && WEBHOOK_PENDING.test(e.failReason ?? ""))) throw e;
    }
    await sleep(1000);
  }
  return null;
}

export async function attemptBooking(req: BookingRequest, deps: BookingDeps): Promise<BookingOutcome> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const f = deps.fetch;
  try {
    const token = await InflowSession.welcome(req.lot, f);
    const s = new InflowSession(req.lot, token, deps.getIdToken, { fetch: f });

    if (req.accessKey) {
      try {
        await s.call("/apply-code", { promoCode: req.accessKey }, { auth: true });
      } catch (e) {
        log("apply-code-failed", (e as InflowError).failReason ?? String(e));
      }
    }

    const { calendars } = await s.calendars();
    const cal = calendars[0]?.bookingCalendarID;
    if (!cal) return { kind: "lost", reason: "NoCalendar" };
    await s.calendarAvailability(cal, req.date.slice(0, 7));
    const { rates } = await s.calendarRates(req.date);
    const rate = chooseRate(Object.values(rates ?? {}), { carpool: req.carpool });
    if (!rate) return { kind: "lost", reason: "NoRateAvailable" };

    await s.selectRate(rate.inventoryTreeRateMiniID);
    const st = await s.sessionStatus();
    if (st.holdReleaseTimestamp?.startsWith("2000-01-01")) return { kind: "paused", reason: "PurchaseInProgress" };
    const holdUntil = st.holdReleaseTimestamp ? Date.parse(st.holdReleaseTimestamp) : Date.now() + 9 * 60_000;
    log("held", { rate: rate.rateName, holdUntil });

    await s.plate(req.plate);
    const co = await s.checkout();
    const flow = co.transactionDetails?.paymentFlow;
    const amount = Number(co.transactionDetails?.amountDue ?? rate.finalPrice ?? 0);
    const setup = flow === "SetupIntent";
    const intent = await s.paymentIntent({ email: req.email }, setup);
    const base = { amount, rateName: rate.rateName, plate: req.plate };

    if (!intent.clientSecret) {
      const receiptID = await pollConfirm(s, setup, sleep);
      if (!receiptID) return { kind: "lost", reason: "ConfirmTimeout" };
      return { kind: "booked", receiptID, sessionToken: token, ...base };
    }

    const handoff = (reason: string): BookingOutcome => ({
      kind: "handoff",
      sessionToken: token,
      clientSecret: intent.clientSecret!,
      customerSessionClientSecret: intent.customerSessionClientSecret,
      setup,
      holdUntil,
      reason,
      ...base,
    });

    const pk = await (deps.publishableKey ?? (() => findPublishableKey(f)))();
    if (!intent.customerSessionClientSecret) return handoff("NoCustomerSession");
    const { cards } = await listSavedCards({
      publishableKey: pk,
      clientSecret: intent.clientSecret,
      customerSessionClientSecret: intent.customerSessionClientSecret,
      setup,
      fetch: f,
    });
    if (!cards[0]) return handoff("NoSavedCard");
    const out = await confirmWithSavedCard({
      publishableKey: pk,
      clientSecret: intent.clientSecret,
      paymentMethodId: cards[0].id,
      setup,
      fetch: f,
    });
    log("stripe", out.kind);
    if (out.kind === "requires_action") return handoff("3DS");
    if (out.kind === "failed") return handoff("CardFailed");

    const receiptID = await pollConfirm(s, setup, sleep);
    if (!receiptID) return handoff("ConfirmTimeout");
    return { kind: "booked", receiptID, sessionToken: token, ...base };
  } catch (e) {
    const { cls, reason } = classify(e);
    log("error", { cls, reason });
    if (cls === "auth") return { kind: "auth", reason };
    if (cls === "user") return { kind: "paused", reason };
    return { kind: "lost", reason };
  }
}
