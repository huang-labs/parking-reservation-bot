import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/core/crypto";
import { addDays, localToUtc, today } from "../src/core/time";
import type { Env } from "../src/env";
import { installFake } from "./fakes";

const E = env as unknown as Env;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seed(tgUserId: number, date: string, mode: "auto" | "notify" = "auto") {
  const ts = Date.now();
  await E.DB.prepare(
    "INSERT INTO users (tg_user_id, chat_id, name, status, inflow_email, default_plate, prefs_json, created_at, updated_at) VALUES (?, ?, 'T', 'active', 'u@test', 'ABC123', '{}', ?, ?)",
  ).bind(tgUserId, tgUserId, ts, ts).run();
  const id = `w${tgUserId}`;
  await E.DB.prepare("INSERT INTO watches (id, tg_user_id, lot, date, mode, status, created_at, updated_at) VALUES (?, ?, 'alta', ?, ?, 'active', ?, ?)")
    .bind(id, tgUserId, date, mode, ts, ts)
    .run();
  const agent = E.ACCOUNT.get(E.ACCOUNT.idFromName(String(tgUserId)));
  const encPassword = await encrypt(E.CREDS_ENC_KEY, "pw", String(tgUserId));
  await runInDurableObject(agent, async (_o, state) => {
    await state.storage.put("creds", { tgUserId, email: "u@test", encPassword, refreshToken: "r" });
  });
  return id;
}

describe("monitor → agents end to end", () => {
  const date = addDays(today(), 10);

  it("books for every auto watcher when a spot opens, and notifies notify-mode watchers", async () => {
    const rec = installFake({ availability: "Available", rates: [{ id: "r1", name: "Daytime", price: 25 }] });
    const w1 = await seed(101, date);
    const w2 = await seed(102, date);
    const w3 = await seed(103, date, "notify");

    const mon = E.MONITOR.get(E.MONITOR.idFromName(`alta:${date}`));
    await mon.ensure("alta", date);
    expect(await runDurableObjectAlarm(mon)).toBe(true);

    const rows = await E.DB.prepare("SELECT id, status FROM watches ORDER BY id").all<{ id: string; status: string }>();
    const status = Object.fromEntries(rows.results.map((r) => [r.id, r.status]));
    expect(status[w1]).toBe("booked");
    expect(status[w2]).toBe("booked");
    expect(status[w3]).toBe("active");

    const bookings = await E.DB.prepare("SELECT tg_user_id, amount, plate FROM bookings ORDER BY tg_user_id").all();
    expect(bookings.results).toHaveLength(2);

    const texts = rec.telegram.filter((m) => m.method === "sendMessage").map((m) => `${m.body.chat_id}:${m.body.text}`);
    expect(texts.some((t) => t.startsWith("101:🎉 Booked"))).toBe(true);
    expect(texts.some((t) => t.startsWith("103:👀 Spot open"))).toBe(true);

    const info = await mon.info();
    expect(info?.lastStatus).toBe("Available");
    expect(info?.nextAt).toBeGreaterThan(Date.now());
  });

  it("keeps polling quietly while full, and stops when no watches remain", async () => {
    const date = addDays(today(), 11); // storage is shared across tests in a file
    const rec = installFake({ availability: "Full", rates: [] });
    const w = await seed(201, date);
    const mon = E.MONITOR.get(E.MONITOR.idFromName(`alta:${date}`));
    await mon.ensure("alta", date);
    await runDurableObjectAlarm(mon);
    expect(rec.calls.some((c) => c.path === "/select-rate")).toBe(false);
    expect((await mon.info())?.lastStatus).toBe("Full");

    await E.DB.prepare("UPDATE watches SET status = 'cancelled' WHERE id = ?").bind(w).run();
    await runDurableObjectAlarm(mon);
    expect(await mon.info()).toBeNull();
  });

  it("hands off to Pay now on 3DS and keeps the watch in booking", async () => {
    const rec = installFake({ availability: "Available", rates: [{ id: "r1", name: "Daytime", price: 25 }], stripeStatus: "requires_action" });
    const w = await seed(301, date);
    const agent = E.ACCOUNT.get(E.ACCOUNT.idFromName("301"));
    const out = await agent.attempt(w);
    expect(out.kind).toBe("handoff");
    const row = await E.DB.prepare("SELECT status FROM watches WHERE id = ?").bind(w).first<{ status: string }>();
    expect(row?.status).toBe("booking");
    const msg = rec.telegram.find((m) => m.body.chat_id === 301);
    expect(msg?.body.text).toContain("Holding");
    expect(msg?.body.reply_markup.inline_keyboard[0][0].web_app.url).toMatch(/^https:\/\/bot\.test\/miniapp\/pay\?t=/);
  });

  it("marks the user needs_login when credentials stop working", async () => {
    const w = await seed(401, date);
    installFake({ availability: "Available", rates: [{ id: "r1", name: "Daytime", price: 25 }], cognitoFail: true });
    const out = await E.ACCOUNT.get(E.ACCOUNT.idFromName("401")).attempt(w);
    expect(out.kind).toBe("auth");
    const u = await E.DB.prepare("SELECT status FROM users WHERE tg_user_id = 401").first<{ status: string }>();
    expect(u?.status).toBe("needs_login");
    const row = await E.DB.prepare("SELECT status FROM watches WHERE id = ?").bind(w).first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("offers Change plate and Cancel on the booked alert", async () => {
    const date = addDays(today(), 12);
    const rec = installFake({
      availability: "Available",
      rates: [{ id: "r1", name: "Daytime", price: 25 }],
      reservations: [
        { reservationID: "R9", status: "Active", startDateTime: new Date(localToUtc(date, "08:00")).toISOString(), plate: "ABC123", confirmationNumber: "C9", receiptIDs: ["RC9"], locationID: "LOC-altaparking" },
      ],
    });
    const w = await seed(501, date);
    expect((await E.ACCOUNT.get(E.ACCOUNT.idFromName("501")).attempt(w)).kind).toBe("booked");
    const msg = rec.telegram.find((m) => m.body.chat_id === 501 && String(m.body.text).startsWith("🎉"));
    expect(msg?.body.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(["bpa:R9", "bx:R9"]);
  });
});
