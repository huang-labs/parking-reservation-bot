import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
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
});
