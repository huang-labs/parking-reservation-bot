import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/core/crypto";
import type { Env } from "../src/env";
import worker from "../src/index";
import { installFake, type Recorder } from "./fakes";

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
});

/** An active user with Inflow credentials in their AccountAgent. */
async function seedUser(id: number, defaultPlate: string | null = "ABC123") {
  const ts = Date.now();
  await E.DB.prepare("INSERT INTO users (tg_user_id, chat_id, name, status, inflow_email, default_plate, created_at, updated_at) VALUES (?, ?, 'U', 'active', 'u@test', ?, ?, ?)")
    .bind(id, id, defaultPlate, ts, ts)
    .run();
  const encPassword = await encrypt(E.CREDS_ENC_KEY, "pw", String(id));
  await runInDurableObject(E.ACCOUNT.get(E.ACCOUNT.idFromName(String(id))), async (_o, state) => {
    await state.storage.put("creds", { tgUserId: id, email: "u@test", encPassword, refreshToken: "r" });
  });
}
const lastOut = (rec: Recorder) => rec.telegram.filter((m) => m.method === "sendMessage" || m.method === "editMessageText").at(-1)!.body;
const buttons = (body: any) => (body.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];
const putBodies = (rec: Recorder) => rec.calls.filter((c) => c.path === "/appuser" && c.method === "PUT").map((c) => c.body);

describe("plates in /settings", () => {
  it("adds a typed plate to the Inflow account, keeping the rest of the profile", async () => {
    const rec = installFake({ availability: "Full", rates: [] });
    await seedUser(70);
    await tap(70, "sp");
    expect(buttons(lastOut(rec)).map((b) => b.text)).toContain("⭐ ABC123 (Car) · default");

    await tap(70, "pa");
    await text(70, "!");
    expect(lastOut(rec).text).toContain("doesn't look like a plate");
    expect(putBodies(rec)).toHaveLength(0);

    await text(70, "xyz-789");
    expect(buttons(lastOut(rec)).map((b) => b.callback_data)).toEqual(["pad:XYZ789", "sp"]);
    expect(putBodies(rec)).toHaveLength(0); // nothing written until confirmed
    await tap(70, "pad:XYZ789");
    const [put] = putBodies(rec);
    expect(put.phone).toBe("+15550000000"); // re-sent unchanged
    expect(put.savedPlates.map((p: any) => p.plate)).toEqual(["ABC123", "XYZ789"]);
    expect(put.savedPlates[1]).toMatchObject({ nickname: "", state: "XX" });
    const out = lastOut(rec);
    expect(out.text).toContain("Added <b>XYZ789</b>");
    expect(buttons(out).some((b) => b.callback_data === "pl:XYZ789")).toBe(true);
    const u = await E.DB.prepare("SELECT default_plate FROM users WHERE tg_user_id = 70").first();
    expect(u).toMatchObject({ default_plate: "ABC123" });
  });

  it("makes the first added plate the default, and stores nothing when Inflow rejects a save", async () => {
    const rec = installFake({ availability: "Full", rates: [], savedPlates: [] });
    await seedUser(71, null);
    await tap(71, "pa");
    await text(71, "abc 123");
    await tap(71, "pad:ABC123");
    expect(await E.DB.prepare("SELECT default_plate FROM users WHERE tg_user_id = 71").first()).toMatchObject({ default_plate: "ABC123" });

    const rec2 = installFake({ availability: "Full", rates: [], appUserFail: "SystemError" });
    await tap(71, "pa");
    await text(71, "NEW1");
    await tap(71, "pad:NEW1");
    expect(lastOut(rec2).text).toContain("Inflow didn't save it (SystemError)");
    expect(rec.calls.length).toBeGreaterThan(0);
  });

  it("ignores stray text once the add-plate request has lapsed", async () => {
    const rec = installFake({ availability: "Full", rates: [] });
    await seedUser(73);
    await tap(73, "pa");
    await E.DB.prepare("UPDATE ui_state SET json = ? WHERE tg_user_id = 73").bind(JSON.stringify({ awaiting: { kind: "plate", at: Date.now() - 11 * 60_000 } })).run();
    await text(73, "ok");
    expect(lastOut(rec).text).toContain("<b>Commands</b>"); // falls through to help
    expect(buttons(lastOut(rec)).some((b) => b.callback_data.startsWith("pad:"))).toBe(false);
  });

  it("asks a logged-out user to log in instead of changing a reservation plate", async () => {
    const rec = installFake({ availability: "Full", rates: [] });
    await seedUser(74);
    await E.DB.prepare("UPDATE users SET status = 'needs_login' WHERE tg_user_id = 74").run();
    await tap(74, "bpy:IPCCO-L-R1:XYZ789");
    expect(lastOut(rec).text).toContain("log in again");
    await tap(74, "bl");
    expect(lastOut(rec).text).toContain("log in again");
    expect(rec.calls.some((c) => c.path === "/plate-update")).toBe(false);
  });

  it("removes a plate after confirming, and clears the default when it was the default", async () => {
    const rec = installFake({ availability: "Full", rates: [], savedPlates: [{ plate: "ABC123" }, { plate: "XYZ789" }] });
    await seedUser(72);
    await tap(72, "pr:ABC123");
    expect(buttons(lastOut(rec)).map((b) => b.callback_data)).toEqual(["pry:ABC123", "sp"]);
    await tap(72, "pry:ABC123");
    expect(putBodies(rec)[0].savedPlates).toEqual([{ plate: "XYZ789" }]);
    expect(await E.DB.prepare("SELECT default_plate FROM users WHERE tg_user_id = 72").first()).toMatchObject({ default_plate: null });
    expect(lastOut(rec).text).toContain("No default plate");
  });
});

describe("reservation plates in /bookings", () => {
  const future = new Date(Date.now() + 30 * 86_400_000);
  const resv = (over: Record<string, unknown> = {}) => ({
    reservationID: "IPCCO-L-R1",
    status: "Active",
    startDateTime: future.toISOString(),
    plate: "ABC123",
    allowPlateChangeUntil: new Date(future.getTime() + 5 * 3_600_000).toISOString(),
    confirmationNumber: "CONF1",
    receiptIDs: ["RC0", "RC1"],
    locationID: "LOC-altaparking",
    enterpriseID: "IPCCO",
    bookingCalendarName: "Alta Parking Reservation",
    ...over,
  });

  it("changes the plate after confirming, using the latest receipt", async () => {
    const reservations = [resv()];
    const rec = installFake({ availability: "Full", rates: [], savedPlates: [{ plate: "ABC123" }, { plate: "XYZ789" }], reservations });
    await seedUser(80);
    await text(80, "/bookings");
    const list = lastOut(rec);
    expect(list.text).toContain("plate changeable until");
    expect(buttons(list).map((b) => b.callback_data)).toEqual(["bp:IPCCO-L-R1", "bx:IPCCO-L-R1"]);

    await tap(80, "bp:IPCCO-L-R1");
    const picker = buttons(lastOut(rec));
    expect(picker.find((b) => b.text.includes("ABC123"))?.callback_data).toBe("nop");
    await tap(80, "bc:IPCCO-L-R1:XYZ789");
    expect(lastOut(rec).text).toContain("ABC123 → <b>XYZ789</b>");
    expect(rec.calls.some((c) => c.path === "/plate-update")).toBe(false);

    await tap(80, "bpy:IPCCO-L-R1:XYZ789");
    const call = rec.calls.find((c) => c.path === "/plate-update")!;
    expect(call.body).toEqual({ newPlate: "XYZ789", reservationID: "IPCCO-L-R1", receiptID: "RC1" });
    const done = lastOut(rec);
    expect(done.text).toContain("is now on <b>XYZ789</b>");
    expect(done.text).toContain("XYZ789 · <code>CONF1</code>");
  });

  it("locks the plate once the change window has passed", async () => {
    const rec = installFake({ availability: "Full", rates: [], reservations: [resv({ allowPlateChangeUntil: new Date(Date.now() - 60_000).toISOString() })] });
    await seedUser(81);
    await text(81, "/bookings");
    expect(lastOut(rec).text).toContain("plate locked");
    expect(buttons(lastOut(rec)).map((b) => b.callback_data)).toEqual(["bx:IPCCO-L-R1"]);
  });

  it("explains an Inflow refusal", async () => {
    const rec = installFake({ availability: "Full", rates: [], reservations: [resv()], plateUpdateFail: "ReservationExistsForPlate" });
    await seedUser(82);
    await tap(82, "bpy:IPCCO-L-R1:XYZ789");
    expect(lastOut(rec).text).toContain("XYZ789 already has a reservation that day.");
  });
});

describe("plate on new watches", () => {
  it("books the picked dates with a chosen saved plate", async () => {
    const rec = installFake({ availability: "Full", rates: [], savedPlates: [{ plate: "ABC123" }, { plate: "XYZ789", nickname: "Van" }] });
    await seedUser(90);
    await tap(90, "wl:alta");
    expect(buttons(lastOut(rec)).find((b) => b.callback_data === "wpl")?.text).toBe("🚘 Plate: ABC123 (default)");
    await tap(90, "wpl");
    expect(buttons(lastOut(rec)).map((b) => b.callback_data)).toEqual(["wps:", "wps:XYZ789", "wpb"]);
    await tap(90, "wps:XYZ789");
    const cal = lastOut(rec);
    expect(buttons(cal).find((b) => b.callback_data === "wpl")?.text).toBe("🚘 Plate: XYZ789");

    const next = buttons(cal)[2]!.callback_data; // ›
    await tap(90, next);
    const day = buttons(lastOut(rec)).find((b) => b.callback_data.startsWith("wd:"))!;
    await tap(90, day.callback_data);
    await tap(90, "wok");
    expect(await E.DB.prepare("SELECT plate_override FROM watches WHERE tg_user_id = 90").first()).toMatchObject({ plate_override: "XYZ789" });
  });
});
