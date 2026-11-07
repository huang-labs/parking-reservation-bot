import { describe, expect, it } from "vitest";
import { CADENCE, nextPollDelay } from "../src/core/cadence";
import { decrypt, encrypt } from "../src/core/crypto";
import { chooseRate } from "../src/core/rates";
import { verifyInitData } from "../src/core/telegramAuth";
import { localParts, localToUtc, watchDeadline } from "../src/core/time";

describe("time (America/Denver)", () => {
  it("converts local wall-clock to UTC across DST", () => {
    expect(new Date(localToUtc("2027-01-16", "08:00")).toISOString()).toBe("2027-01-16T15:00:00.000Z"); // MST
    expect(new Date(localToUtc("2027-04-10", "08:00")).toISOString()).toBe("2027-04-10T14:00:00.000Z"); // MDT
    expect(localParts(Date.parse("2027-01-17T02:30:00Z")).date).toBe("2027-01-16");
  });
});

describe("poll cadence", () => {
  const alta = [{ kind: "weekly" as const, weekday: 0, localTime: "15:00" }];
  it("polls every 60s normally", () => {
    const now = localToUtc("2027-01-06", "12:00"); // Wed
    expect(nextPollDelay({ now, date: "2027-01-16", windows: alta, lastStatus: "Full" })).toBe(CADENCE.baseMs);
  });
  it("bursts at 5s inside a release window", () => {
    const now = localToUtc("2027-01-10", "15:03"); // Sun 3:03pm
    expect(nextPollDelay({ now, date: "2027-01-16", windows: alta, lastStatus: "Full" })).toBe(CADENCE.burstMs);
  });
  it("wakes up right before a window instead of sleeping through it", () => {
    const now = localToUtc("2027-01-10", "14:57"); // window opens 14:58
    expect(nextPollDelay({ now, date: "2027-01-16", windows: alta, lastStatus: "Full" })).toBe(60_000);
    const now2 = localToUtc("2027-01-10", "14:57") + 30_000;
    expect(nextPollDelay({ now: now2, date: "2027-01-16", windows: alta, lastStatus: "Full" })).toBe(30_000);
  });
  it("polls every 15s in the last 24h and when holds may lapse", () => {
    expect(nextPollDelay({ now: watchDeadline("2027-01-16") - 3_600_000 * 10, date: "2027-01-16", windows: [], lastStatus: "Full" })).toBe(CADENCE.nearMs);
    expect(nextPollDelay({ now: localToUtc("2027-01-06", "12:00"), date: "2027-01-16", windows: [], lastStatus: "FullButNotAllConfirmed" })).toBe(CADENCE.nearMs);
  });
  it("backs off when inventory isn't released yet", () => {
    expect(nextPollDelay({ now: localToUtc("2027-01-06", "12:00"), date: "2027-01-16", windows: [], lastStatus: "ComingSoon" })).toBe(CADENCE.idleMs);
  });
  it("handles days-before windows (Brighton day-before 8am)", () => {
    const w = [{ kind: "days_before" as const, daysBefore: 1, localTime: "08:00" }];
    expect(nextPollDelay({ now: localToUtc("2027-01-15", "08:10"), date: "2027-01-16", windows: w, lastStatus: "Full" })).toBe(CADENCE.burstMs);
  });
});

describe("rate choice", () => {
  const r = (id: string, rateName: string, finalPrice: number, rateStatus = "Available") => ({ inventoryTreeRateMiniID: id, rateName, finalPrice, rateStatus });
  const rates = [r("gen", "General Parking", 25), r("cp", "Carpool 4+", 10), r("pref", "Preferred", 30), r("pass", "Passholder", 0, "SoldOut")];
  it("picks the cheapest non-carpool rate by default", () => expect(chooseRate(rates, { carpool: false })?.inventoryTreeRateMiniID).toBe("gen"));
  it("prefers carpool for carpoolers", () => expect(chooseRate(rates, { carpool: true })?.inventoryTreeRateMiniID).toBe("cp"));
  it("carpoolers fall back to regular when carpool is gone", () =>
    expect(chooseRate([r("gen", "General", 25), r("cp", "Carpool 4+", 10, "SoldOut")], { carpool: true })?.inventoryTreeRateMiniID).toBe("gen"));
  it("returns null when nothing is available", () => expect(chooseRate([r("x", "General", 25, "SoldOut")], { carpool: false })).toBeNull());
});

describe("credential encryption", () => {
  const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  it("round-trips and binds to the user id", async () => {
    const blob = await encrypt(key, "hunter2", "42");
    expect(await decrypt(key, blob, "42")).toBe("hunter2");
    await expect(decrypt(key, blob, "43")).rejects.toThrow();
  });
});

describe("Mini App initData", () => {
  async function sign(params: Record<string, string>, token: string) {
    const enc = new TextEncoder();
    const hmac = async (k: BufferSource, d: string) =>
      crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(d));
    const secret = await hmac(enc.encode("WebAppData"), token);
    const check = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("\n");
    const hash = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new URLSearchParams({ ...params, hash }).toString();
  }
  it("accepts valid, rejects tampered and stale", async () => {
    const params = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 7, first_name: "A" }) };
    const good = await sign(params, "123:tok");
    expect((await verifyInitData(good, "123:tok"))?.id).toBe(7);
    expect(await verifyInitData(good.replace("%22id%22%3A7", "%22id%22%3A8"), "123:tok")).toBeNull();
    expect(await verifyInitData(good, "123:other")).toBeNull();
    const stale = await sign({ ...params, auth_date: String(Math.floor(Date.now() / 1000) - 3600) }, "123:tok");
    expect(await verifyInitData(stale, "123:tok")).toBeNull();
  });
});
