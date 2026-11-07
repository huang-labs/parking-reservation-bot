import { and, eq, inArray, lt, lte, or } from "drizzle-orm";
import { handleWebhook } from "./bot/bot";
import { platePicker } from "./bot/views";
import { verifyInitData } from "./core/telegramAuth";
import { localParts, today } from "./core/time";
import { db, getUser, logEvent, now } from "./db/repo";
import { events, users, watches } from "./db/schema";
import { account, type Env, monitor } from "./env";
import type { LotKey } from "./inflow/client";
import { loginPage, payPage } from "./miniapp/pages";
import { alertAdmin, esc, send } from "./telegram";

export { AccountAgent } from "./do/account";
export { LotDateMonitor } from "./do/monitor";
export { ScoutSession } from "./do/scout";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

async function miniAppUser(env: Env, body: { initData?: string }) {
  const u = body.initData ? await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN) : null;
  if (!u) return null;
  const user = await getUser(db(env.DB), u.id);
  return user && user.status !== "disabled" ? user : null;
}

async function miniAppLogin(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { initData?: string; email?: string; password?: string };
  const user = await miniAppUser(env, body);
  if (!user) return json({ ok: false, error: "Open this from the bot chat (/start)." }, 403);
  if (!body.email || !body.password) return json({ ok: false, error: "Email and password required." }, 400);
  const r = await account(env, user.tgUserId).connectInflow(user.tgUserId, body.email, body.password);
  if (!r.ok) return json(r, 401);
  const d = db(env.DB);
  const plates = r.plates;
  const defaultPlate = user.defaultPlate ?? (plates.length === 1 ? plates[0]!.plate : null);
  await d
    .update(users)
    .set({ inflowEmail: body.email, status: "active", defaultPlate, updatedAt: now() })
    .where(eq(users.tgUserId, user.tgUserId));
  await logEvent(d, "connected", { plates: plates.length }, { tgUserId: user.tgUserId });
  const hi = `✅ Connected${r.firstName ? `, ${esc(r.firstName)}` : ""}!`;
  if (defaultPlate) {
    await send(env, user.chatId, `${hi} Default plate: <b>${esc(defaultPlate)}</b> (change in /settings).\n\nNext: /watch to pick dates. Passholder code or carpool? Set it in /settings.`);
  } else if (plates.length) {
    await send(env, user.chatId, `${hi} Pick your default plate:`, { keyboard: platePicker(plates) });
  } else {
    await send(env, user.chatId, `${hi} Your Inflow account has no saved plates — add one in the Inflow app, then /settings → Change plate.`);
  }
  return json({ ok: true });
}

async function miniAppPay(req: Request, env: Env, action: "info" | "done"): Promise<Response> {
  const body = (await req.json()) as { initData?: string; t?: string };
  const user = await miniAppUser(env, body);
  if (!user || !body.t) return json({ ok: false, error: "Open this from the bot chat." }, 403);
  const agent = account(env, user.tgUserId);
  if (action === "info") {
    const info = await agent.paymentInfo(body.t);
    return info ? json({ ok: true, ...info }) : json({ ok: false, error: "This hold has expired or was already paid." });
  }
  return json(await agent.paid(body.t));
}

/** Safety net: re-arm monitors, expire stale watches, purge old rows. */
async function reconcile(env: Env) {
  const d = db(env.DB);
  const ts = Date.now();
  const lp = localParts(ts);
  const todayStr = today(ts);

  // expire watches whose 08:00 deadline has passed
  const expiredBefore = lp.minutes >= 8 * 60 ? todayStr : null;
  await d
    .update(watches)
    .set({ status: "expired", updatedAt: ts })
    .where(
      and(
        inArray(watches.status, ["active", "paused"]),
        expiredBefore ? lte(watches.date, expiredBefore) : lt(watches.date, todayStr),
      ),
    );

  // re-arm a monitor for every (lot, date) with an active watch (idempotent)
  const pairs = await d
    .selectDistinct({ lot: watches.lot, date: watches.date })
    .from(watches)
    .innerJoin(users, eq(users.tgUserId, watches.tgUserId))
    .where(and(eq(watches.status, "active"), eq(users.status, "active")))
    .all();
  await Promise.all(pairs.map((p) => monitor(env, p.lot, p.date).ensure(p.lot as LotKey, p.date)));

  // stuck "booking" watches (agent crashed mid-attempt) go back to active after 15 min
  await d
    .update(watches)
    .set({ status: "active", updatedAt: ts })
    .where(and(eq(watches.status, "booking"), lt(watches.updatedAt, ts - 15 * 60_000)));

  // daily retention purge at ~03:00 local
  if (lp.h === 3 && lp.mi < 5) {
    const cutoff = ts - 90 * 86_400_000;
    await d.delete(events).where(lt(events.at, cutoff));
    await d
      .delete(watches)
      .where(and(or(eq(watches.status, "expired"), eq(watches.status, "cancelled")), lt(watches.updatedAt, cutoff)));
  }
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/telegram") return await handleWebhook(req, env, exec);
      if (url.pathname === "/miniapp/login") return req.method === "POST" ? await miniAppLogin(req, env) : html(loginPage());
      if (url.pathname === "/miniapp/pay" && req.method === "GET") return html(payPage());
      if (url.pathname === "/miniapp/pay/info" && req.method === "POST") return await miniAppPay(req, env, "info");
      if (url.pathname === "/miniapp/pay/done" && req.method === "POST") return await miniAppPay(req, env, "done");
      if (url.pathname === "/") return new Response("parking-reservation-bot");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(JSON.stringify({ event: "unhandled", path: url.pathname, error: String(e), stack: (e as Error).stack }));
      exec.waitUntil(alertAdmin(env, "unhandled-error", `${esc(url.pathname)}: ${esc(String(e)).slice(0, 300)}`));
      return json({ ok: false, error: "Internal error" }, 500);
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil(
      reconcile(env).catch((e) => alertAdmin(env, "cron-error", esc(String(e)).slice(0, 300))),
    );
  },
} satisfies ExportedHandler<Env>;

