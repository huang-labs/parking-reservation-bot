import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { encrypt } from "../src/core/crypto";
import { installFake } from "./fakes";

const E = env as unknown as Env;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let updateId = 1;
const from = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
const chat = (id: number) => ({ id, type: "private" as const, first_name: `U${id}` });

async function send(update: Record<string, unknown>, secret = "hook-secret") {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://bot.test/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: updateId++, ...update }),
    }),
    E,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const text = (uid: number, t: string) =>
  send({
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: chat(uid),
      from: from(uid),
      text: t,
      entities: t.startsWith("/") ? [{ type: "bot_command", offset: 0, length: t.split(" ")[0]!.length }] : [],
    },
  });
const tap = (uid: number, data: string) =>
  send({
    callback_query: {
      id: String(updateId),
      from: from(uid),
      chat_instance: "x",
      data,
      message: { message_id: 5, date: 0, chat: chat(uid), text: "x" },
    },
  });

describe("telegram webhook", () => {
  it("rejects a bad secret", async () => {
    installFake({ availability: "Full", rates: [] });
    expect((await send({ message: {} }, "wrong")).status).toBe(401);
  });

  it("admin onboarding, invite, and invite-only gate", async () => {
    const rec = installFake({ availability: "Full", rates: [] });
    await text(1, "/start");
    const welcome = rec.telegram.find((m) => m.method === "sendMessage" && m.body.chat_id === 1);
    expect(welcome?.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://bot.test/miniapp/login");
    const admin = await E.DB.prepare("SELECT role, status FROM users WHERE tg_user_id = 1").first();
    expect(admin).toMatchObject({ role: "admin", status: "new" });

    await text(50, "/start");
    expect(rec.telegram.at(-1)!.body.text).toContain("invite-only");

    await tap(1, "ai");
    const link = rec.telegram.filter((m) => m.method === "sendMessage").at(-1)!.body.text as string;
    const code = link.match(/start=(\w+)/)![1]!;
    await text(50, `/start ${code}`);
    expect(await E.DB.prepare("SELECT status FROM users WHERE tg_user_id = 50").first()).toMatchObject({ status: "new" });
    await text(51, `/start ${code}`); // single-use
    expect(rec.telegram.at(-1)!.body.text).toContain("invite-only");
  });

  it("/watch → lot → calendar → pick dates → watching", async () => {
    const rec = installFake({ availability: "Full", rates: [] });
    const ts = Date.now();
    await E.DB.prepare("INSERT INTO users (tg_user_id, chat_id, name, status, default_plate, created_at, updated_at) VALUES (60, 60, 'U', 'active', 'ABC', ?, ?)").bind(ts, ts).run();
    await text(60, "/watch");
    expect(rec.telegram.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe("wl:alta");

    await tap(60, "wl:alta");
    const first = rec.telegram.filter((m) => m.method === "editMessageText").at(-1)!;
    const next = (first.body.reply_markup.inline_keyboard[0] as { callback_data: string }[])[2]!.callback_data;
    await tap(60, next); // next month always has future days
    const cal = rec.telegram.filter((m) => m.method === "editMessageText").at(-1)!;
    const buttons = (cal.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
    const day = buttons.find((b) => b.callback_data.startsWith("wd:") && b.text.includes("🔴"));
    expect(day).toBeDefined();

    await tap(60, day!.callback_data);
    await tap(60, "wok");
    const done = rec.telegram.filter((m) => m.method === "editMessageText").at(-1)!;
    expect(done.body.text).toContain("Watching");
    const w = await E.DB.prepare("SELECT lot, date, status, mode FROM watches WHERE tg_user_id = 60").first();
    expect(w).toMatchObject({ lot: "alta", date: day!.callback_data.slice(3), status: "active", mode: "auto" });
  });

  describe("changing a reservation's plate", () => {
    const reservation = (over: Record<string, unknown> = {}) => ({
      reservationID: "RES1",
      status: "Active",
      startDateTime: "2027-01-16T15:00:00.000Z",
      plate: "ABC123",
      confirmationNumber: "CONF1",
      receiptIDs: ["RCPT0", "RCPT1"],
      allowPlateChangeUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bookingCalendarName: "Alta",
      locationID: "LOC-altaparking",
      enterpriseID: "IPCCO",
      locationTimezone: "America/Denver",
      ...over,
    });

    async function connect(uid: number) {
      const ts = Date.now();
      await E.DB.prepare(
        "INSERT INTO users (tg_user_id, chat_id, name, status, inflow_email, default_plate, prefs_json, created_at, updated_at) VALUES (?, ?, 'U', 'active', 'u@test', 'ABC123', '{}', ?, ?)",
      ).bind(uid, uid, ts, ts).run();
      await E.DB.prepare(
        "INSERT INTO bookings (id, tg_user_id, lot, date, inflow_reservation_id, plate, created_at) VALUES (?, ?, 'alta', '2027-01-16', 'RES1', 'ABC123', ?)",
      ).bind(`b${uid}`, uid, ts).run();
      const encPassword = await encrypt(E.CREDS_ENC_KEY, "pw", String(uid));
      await runInDurableObject(E.ACCOUNT.get(E.ACCOUNT.idFromName(String(uid))), async (_o, state) => {
        await state.storage.put("creds", { tgUserId: uid, email: "u@test", encPassword, refreshToken: "r" });
      });
    }
    const lastText = (rec: { telegram: { method: string; body: any }[] }) =>
      rec.telegram.filter((m) => m.method === "sendMessage").at(-1)!.body.text as string;

    it("/bookings → Change plate → typed plate updates the reservation", async () => {
      const s = { availability: "Full", rates: [], reservations: [reservation()] };
      const rec = installFake(s);
      await connect(70);

      await text(70, "/bookings");
      const kb = (rec.telegram.filter((m) => m.method === "sendMessage").at(-1)!.body.reply_markup.inline_keyboard as { callback_data: string }[][]).flat();
      expect(kb.map((b) => b.callback_data)).toEqual(["bp:RES1", "bx:RES1"]);

      await tap(70, "bp:RES1");
      expect(lastText(rec)).toContain("currently ABC123");

      await text(70, "x"); // too short: keeps waiting
      expect(lastText(rec)).toContain("Try again");

      await text(70, "xyz-789");
      const update = rec.calls.find((c) => c.path === "/plate-update");
      expect(update?.body).toEqual({ newPlate: "XYZ789", reservationID: "RES1", receiptID: "RCPT1" });
      expect(lastText(rec)).toContain("now on <b>XYZ789</b>");
      expect(s.reservations[0]!.plate).toBe("XYZ789");
      expect(await E.DB.prepare("SELECT plate FROM bookings WHERE tg_user_id = 70").first()).toMatchObject({ plate: "XYZ789" });

      await text(70, "QQQ111"); // no longer waiting for a plate
      expect(rec.calls.filter((c) => c.path === "/plate-update")).toHaveLength(1);
    });

    it("explains an Inflow refusal and stops waiting", async () => {
      const rec = installFake({ availability: "Full", rates: [], reservations: [reservation()], plateUpdateFail: "ReservationExistsForPlate" });
      await connect(71);
      await tap(71, "bp:RES1");
      await text(71, "XYZ789");
      expect(lastText(rec)).toContain("already has a reservation");
      expect(await E.DB.prepare("SELECT plate FROM bookings WHERE tg_user_id = 71").first()).toMatchObject({ plate: "ABC123" });
      await text(71, "XYZ789");
      expect(rec.calls.filter((c) => c.path === "/plate-update")).toHaveLength(1);
    });

    it("falls back to plain text for an unmapped failReason and stops waiting", async () => {
      const rec = installFake({ availability: "Full", rates: [], reservations: [reservation()], plateUpdateFail: "SystemError" });
      await connect(73);
      await tap(73, "bp:RES1");
      await text(73, "XYZ789");
      expect(lastText(rec)).toContain("couldn't change the plate (SystemError)");
      await text(73, "XYZ789");
      expect(rec.calls.filter((c) => c.path === "/plate-update")).toHaveLength(1);
    });

    it("stops waiting even when the change throws", async () => {
      const rec = installFake({ availability: "Full", rates: [], reservations: [reservation()], plateUpdateHttp500: true });
      await connect(74);
      await tap(74, "bp:RES1");
      await text(74, "XYZ789");
      const toUser = rec.telegram.filter((m) => m.method === "sendMessage" && m.body.chat_id === 74).map((m) => m.body.text as string);
      expect(toUser.at(-1)).toContain("Something went wrong");
      await text(74, "XYZ789");
      expect(rec.calls.filter((c) => c.path === "/plate-update")).toHaveLength(1);
    });

    it("hides the button once the change window has closed", async () => {
      const rec = installFake({
        availability: "Full",
        rates: [],
        reservations: [reservation({ allowPlateChangeUntil: new Date(Date.now() - 60_000).toISOString() })],
      });
      await connect(72);
      await text(72, "/bookings");
      const kb = (rec.telegram.filter((m) => m.method === "sendMessage").at(-1)!.body.reply_markup.inline_keyboard as { callback_data: string }[][]).flat();
      expect(kb.map((b) => b.callback_data)).toEqual(["bx:RES1"]);
    });
  });
});
