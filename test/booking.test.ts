import { afterEach, describe, expect, it } from "vitest";
import { attemptBooking } from "../src/core/booking";
import { installFake, type Scenario } from "./fakes";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = { lot: "alta" as const, date: "2027-01-16", plate: "ABC123", email: "a@b.c", carpool: false };
const deps = { getIdToken: async () => "id-token", sleep: async () => {} };
const base: Scenario = { availability: "Available", rates: [{ id: "r1", name: "Daytime Parking Reservation", price: 25 }] };

describe("attemptBooking", () => {
  it("books a paid spot headlessly with the saved card", async () => {
    const rec = installFake(base);
    const o = await attemptBooking(req, deps);
    expect(o).toMatchObject({ kind: "booked", receiptID: "RCPT1", amount: 25, plate: "ABC123" });
    const paths = rec.calls.map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(["/select-rate", "/plate", "/checkout", "/payment-intent", "/v1/payment_intents/pi_123/confirm", "/confirm-payment"]));
    expect(rec.calls.find((c) => c.path.endsWith("/confirm"))!.body.payment_method).toBe("pm_1");
    expect(paths.indexOf("/calendar-availability")).toBeLessThan(paths.indexOf("/calendar-rates"));
  });

  it("books free rates without Stripe", async () => {
    const rec = installFake({ ...base, paymentFlow: "Free", rates: [{ id: "p", name: "Passholder", price: 0 }] });
    const o = await attemptBooking({ ...req, accessKey: "PASS1" }, deps);
    expect(o.kind).toBe("booked");
    expect(rec.calls.some((c) => c.url.includes("stripe"))).toBe(false);
    expect(rec.calls.find((c) => c.path === "/apply-code")!.body.promoCode).toBe("PASS1");
  });

  it("hands off to the user on 3DS", async () => {
    installFake({ ...base, stripeStatus: "requires_action" });
    const o = await attemptBooking(req, deps);
    expect(o).toMatchObject({ kind: "handoff", reason: "3DS", clientSecret: "pi_123_secret_abc", setup: false });
  });

  it("uses SetupIntent flow for card-hold rates", async () => {
    const rec = installFake({ ...base, paymentFlow: "SetupIntent" });
    expect((await attemptBooking(req, deps)).kind).toBe("booked");
    expect(rec.calls.some((c) => c.path === "/setup-intent")).toBe(true);
    expect(rec.calls.some((c) => c.path === "/v1/setup_intents/pi_123/confirm")).toBe(true);
  });

  it("treats a lost race as transient", async () => {
    installFake({ ...base, selectFail: "ReservationCapacityReached" });
    expect(await attemptBooking(req, deps)).toEqual({ kind: "lost", reason: "ReservationCapacityReached" });
  });

  it("pauses on account limits", async () => {
    installFake({ ...base, selectFail: "MaxConcurrentReservationsReached" });
    expect(await attemptBooking(req, deps)).toEqual({ kind: "paused", reason: "MaxConcurrentReservationsReached" });
  });

  it("pauses when another checkout is in progress", async () => {
    installFake({ ...base, holdSentinel: true });
    expect(await attemptBooking(req, deps)).toEqual({ kind: "paused", reason: "PurchaseInProgress" });
  });

  it("reports expired Cognito tokens as auth", async () => {
    installFake({ ...base, selectFail: "CognitoTokenExpired" });
    expect((await attemptBooking(req, deps)).kind).toBe("auth");
  });

  it("is lost when no rate is open", async () => {
    installFake({ ...base, rates: [{ id: "r1", name: "General", price: 25, status: "SoldOut" }] });
    expect(await attemptBooking(req, deps)).toEqual({ kind: "lost", reason: "NoRateAvailable" });
  });
});
