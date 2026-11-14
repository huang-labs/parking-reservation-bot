import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Bot, type Context, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { randomId } from "../core/crypto";
import { normalizePlate } from "../core/plates";
import { prettyDate, today } from "../core/time";
import { db, type DB, getConfig, getUser, getWatch, now, prefsOf, setConfig, transitionWatch, upsertWatch } from "../db/repo";
import { events, invites, releaseWindows, uiState, type User, type UserPrefs, users, watches } from "../db/schema";
import { account, type Env, monitor, scout } from "../env";
import { LOTS, type LotKey } from "../inflow/client";
import { esc, type Keyboard } from "../telegram";
import {
  bookingsView,
  calendarView,
  HELP,
  loginKeyboard,
  lotName,
  lotPicker,
  platesView,
  reservationPlatePicker,
  settingsView,
  type WatchDraft,
  watchesView,
  watchPlatePicker,
} from "./views";

type Ctx = Context & { env: Env; d: DB; user: User | null; exec: ExecutionContext };

interface UiState {
  draft?: WatchDraft;
  awaiting?: { kind: "accessKey"; lot: LotKey } | { kind: "plate" };
}

let botInfo: UserFromGetMe | undefined;

const markup = (keyboard: Keyboard) => ({ reply_markup: { inline_keyboard: keyboard } as never });
const isLot = (s: string): s is LotKey => s in LOTS;

async function loadUi(d: DB, id: number): Promise<UiState> {
  const row = await d.select().from(uiState).where(eq(uiState.tgUserId, id)).get();
  return row ? (JSON.parse(row.json) as UiState) : {};
}
async function saveUi(d: DB, id: number, s: UiState) {
  const json = JSON.stringify(s);
  await d.insert(uiState).values({ tgUserId: id, json, updatedAt: now() }).onConflictDoUpdate({ target: uiState.tgUserId, set: { json, updatedAt: now() } });
}
async function savePrefs(d: DB, id: number, prefs: UserPrefs) {
  await d.update(users).set({ prefsJson: JSON.stringify(prefs), updatedAt: now() }).where(eq(users.tgUserId, id));
}

export function makeBot(env: Env, exec: ExecutionContext) {
  const bot = new Bot<Ctx>(env.TELEGRAM_BOT_TOKEN, { botInfo });
  const adminId = Number(env.ADMIN_TG_USER_ID);

  bot.use(async (ctx, next) => {
    ctx.env = env;
    ctx.exec = exec;
    ctx.d = db(env.DB);
    ctx.user = ctx.from ? await getUser(ctx.d, ctx.from.id) : null;
    if (ctx.chat && ctx.chat.type !== "private") return; // private chats only
    await next();
  });

  // ---------- onboarding ----------

  bot.command("start", async (ctx) => {
    const from = ctx.from!;
    const code = ctx.match?.trim();
    let user = ctx.user;
    if (!user) {
      const isAdmin = from.id === adminId;
      if (!isAdmin) {
        const invite = code ? await ctx.d.select().from(invites).where(and(eq(invites.code, code), isNull(invites.usedBy))).get() : null;
        if (!invite) return ctx.reply("This bot is invite-only. Ask the owner for an invite link.");
        await ctx.d.update(invites).set({ usedBy: from.id, usedAt: now() }).where(eq(invites.code, code!));
      }
      const ts = now();
      await ctx.d.insert(users).values({
        tgUserId: from.id,
        chatId: ctx.chat!.id,
        name: [from.first_name, from.last_name].filter(Boolean).join(" "),
        role: isAdmin ? "admin" : "user",
        status: "new",
        createdAt: ts,
        updatedAt: ts,
      });
      user = (await getUser(ctx.d, from.id))!;
    }
    if (user.status === "disabled") return ctx.reply("Your access has been disabled.");
    if (user.status === "active") return ctx.reply(`Welcome back! 👋\n\n${HELP}`, { parse_mode: "HTML" });
    return ctx.reply(
      "🏔 <b>Parking sniper</b> for Alta, Brighton & Solitude.\n\nWatch sold-out dates and I'll book the moment a spot frees up, using your own Inflow account and saved card.\n\nFirst, connect your Inflow account (your password goes to the bot over HTTPS, never into this chat):",
      { parse_mode: "HTML", ...markup(loginKeyboard(env.PUBLIC_URL)) },
    );
  });

  // everything below requires a known, enabled user
  bot.use(async (ctx, next) => {
    if (!ctx.user) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return ctx.reply("Send /start <invite-code> to begin.");
    }
    if (ctx.user.status === "disabled") return;
    await next();
  });

  const requireActive = async (ctx: Ctx) => {
    if (ctx.user?.status === "active") return true;
    await ctx.reply(
      ctx.user?.status === "needs_login" ? "🔐 Your Inflow login expired — log in again:" : "Connect your Inflow account first:",
      markup(loginKeyboard(env.PUBLIC_URL)),
    );
    return false;
  };

  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

  // ---------- /watch ----------

  bot.command("watch", async (ctx) => {
    if (!(await requireActive(ctx))) return;
    await ctx.reply("Which lot?", markup(lotPicker()));
  });

  async function renderCalendar(ctx: Ctx, draft: WatchDraft, edit = true) {
    const [avail, mine] = await Promise.all([
      scout(env).availability(draft.lot, draft.month, 60_000).catch(() => null),
      ctx.d
        .select({ date: watches.date })
        .from(watches)
        .where(and(eq(watches.tgUserId, ctx.user!.tgUserId), eq(watches.lot, draft.lot), inArray(watches.status, ["active", "paused", "booking", "booked"])))
        .all(),
    ]);
    const v = calendarView({
      draft,
      availability: avail,
      watched: new Set(mine.map((r) => r.date)),
      today: today(),
      prefs: prefsOf(ctx.user!),
      defaultPlate: ctx.user!.defaultPlate,
    });
    if (edit) await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
    else await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  }

  async function withDraft(ctx: Ctx, fn: (d: WatchDraft) => WatchDraft | void) {
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    if (!ui.draft) {
      await ctx.answerCallbackQuery("That picker expired — /watch again.");
      return;
    }
    ui.draft = fn(ui.draft) ?? ui.draft;
    await saveUi(ctx.d, ctx.user!.tgUserId, ui);
    await ctx.answerCallbackQuery();
    await renderCalendar(ctx, ui.draft);
  }

  bot.callbackQuery(/^wl:(.+)$/, async (ctx) => {
    const lot = ctx.match[1]!;
    if (!isLot(lot)) return ctx.answerCallbackQuery();
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    ui.draft = { lot, month: today().slice(0, 7), selected: [], mode: "auto", carpool: null, plate: null };
    await saveUi(ctx.d, ctx.user!.tgUserId, ui);
    await ctx.answerCallbackQuery();
    await renderCalendar(ctx, ui.draft);
  });
  bot.callbackQuery(/^wc:(\d{4}-\d{2})$/, (ctx) => withDraft(ctx, (d) => ({ ...d, month: ctx.match[1]! })));
  bot.callbackQuery(/^wd:(\d{4}-\d{2}-\d{2})$/, (ctx) =>
    withDraft(ctx, (d) => {
      const date = ctx.match[1]!;
      d.selected = d.selected.includes(date) ? d.selected.filter((x) => x !== date) : [...d.selected, date].sort();
    }),
  );
  bot.callbackQuery("wm", (ctx) => withDraft(ctx, (d) => ({ ...d, mode: d.mode === "auto" ? "notify" : "auto" })));
  bot.callbackQuery("wcp", (ctx) =>
    withDraft(ctx, (d) => {
      const def = Boolean(prefsOf(ctx.user!).carpool?.[d.lot]);
      const eff = d.carpool ?? def;
      return { ...d, carpool: !eff === def ? null : !eff };
    }),
  );
  bot.callbackQuery("wpl", async (ctx) => {
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    if (!ui.draft) return ctx.answerCallbackQuery("That picker expired — /watch again.");
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { plates } = await account(env, ctx.user!.tgUserId).profile();
    const v = watchPlatePicker(plates, ctx.user!.defaultPlate, ui.draft.plate ?? null);
    await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  });
  bot.callbackQuery(/^wps:([A-Z0-9]*)$/, (ctx) => withDraft(ctx, (d) => ({ ...d, plate: ctx.match[1] || null })));
  bot.callbackQuery("wpb", (ctx) => withDraft(ctx, () => {}));
  bot.callbackQuery("wback", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Which lot?", markup(lotPicker()));
  });
  bot.callbackQuery("nop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery("wok", async (ctx) => {
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    const draft = ui.draft;
    if (!draft?.selected.length) return ctx.answerCallbackQuery("Tap one or more dates first.");
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    const created = [];
    for (const date of draft.selected) {
      const existing = await ctx.d
        .select()
        .from(watches)
        .where(and(eq(watches.tgUserId, ctx.user!.tgUserId), eq(watches.lot, draft.lot), eq(watches.date, date)))
        .get();
      if (existing && ["booked", "booking"].includes(existing.status)) continue;
      created.push(
        await upsertWatch(ctx.d, {
          tgUserId: ctx.user!.tgUserId,
          lot: draft.lot,
          date,
          mode: draft.mode,
          carpoolOverride: draft.carpool,
          plateOverride: draft.plate ?? null,
        }),
      );
      await monitor(env, draft.lot, date).ensure(draft.lot, date, { soon: true });
    }
    delete ui.draft;
    await saveUi(ctx.d, ctx.user!.tgUserId, ui);
    await ctx.answerCallbackQuery("Watching!");
    await ctx.editMessageText(
      `👀 Watching <b>${lotName(draft.lot)}</b>: ${created.map((w) => prettyDate(w.date)).join(", ") || "nothing new"} · ${draft.mode === "auto" ? "auto-book" : "notify"}${draft.plate ? ` · 🚘 ${esc(draft.plate)}` : ""}.\nIf a date already has spots I'll grab one within seconds.`,
      { parse_mode: "HTML" },
    );
  });

  // ---------- /watches ----------

  async function myWatches(ctx: Ctx) {
    return ctx.d
      .select()
      .from(watches)
      .where(and(eq(watches.tgUserId, ctx.user!.tgUserId), inArray(watches.status, ["active", "paused", "booking", "booked"])))
      .orderBy(watches.date)
      .all();
  }

  bot.command("watches", async (ctx) => {
    const v = watchesView(await myWatches(ctx));
    await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  });

  async function refreshWatches(ctx: Ctx, toast: string) {
    await ctx.answerCallbackQuery(toast);
    const v = watchesView(await myWatches(ctx));
    await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) }).catch(() => {});
  }

  async function ownWatch(ctx: Ctx, id: string) {
    const w = await getWatch(ctx.d, id);
    return w && w.tgUserId === ctx.user!.tgUserId ? w : null;
  }

  bot.callbackQuery(/^wp:(.+)$/, async (ctx) => {
    const w = await ownWatch(ctx, ctx.match[1]!);
    if (w) await transitionWatch(ctx.d, w.id, ["active"], "paused", { pauseReason: "paused by you" });
    await refreshWatches(ctx, "Paused");
  });
  bot.callbackQuery(/^wr:(.+)$/, async (ctx) => {
    const w = await ownWatch(ctx, ctx.match[1]!);
    if (w && (await transitionWatch(ctx.d, w.id, ["paused"], "active"))) {
      await monitor(env, w.lot, w.date).ensure(w.lot as LotKey, w.date, { soon: true });
    }
    await refreshWatches(ctx, "Resumed");
  });
  bot.callbackQuery(/^wx:(.+)$/, async (ctx) => {
    const w = await ownWatch(ctx, ctx.match[1]!);
    if (w) await transitionWatch(ctx.d, w.id, ["active", "paused"], "cancelled");
    await refreshWatches(ctx, "Removed");
  });
  bot.callbackQuery(/^wt:(.+)$/, async (ctx) => {
    const w = await ownWatch(ctx, ctx.match[1]!);
    if (w) await ctx.d.update(watches).set({ mode: w.mode === "auto" ? "notify" : "auto", updatedAt: now() }).where(eq(watches.id, w.id));
    await refreshWatches(ctx, "Mode changed");
  });

  bot.callbackQuery(/^bn:(.+)$/, async (ctx) => {
    const w = await ownWatch(ctx, ctx.match[1]!);
    if (!w) return ctx.answerCallbackQuery("Watch not found.");
    await ctx.answerCallbackQuery("Booking…");
    await ctx.reply(`⚡ Trying to book ${lotName(w.lot)} · ${prettyDate(w.date)}…`);
    ctx.exec.waitUntil(account(env, w.tgUserId).attempt(w.id, { manual: true }));
  });

  // ---------- /bookings ----------

  bot.command("bookings", async (ctx) => {
    if (!(await requireActive(ctx))) return;
    await ctx.replyWithChatAction("typing");
    const v = bookingsView(await account(env, ctx.user!.tgUserId).reservations());
    await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  });

  async function showBookings(ctx: Ctx, header = "") {
    const v = bookingsView(await account(env, ctx.user!.tgUserId).reservations(), Date.now(), header);
    await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) }).catch(() => {});
  }

  // 🚘 Plate: bp edits the /bookings message in place; bpa (from the 🎉 Booked alert) opens a new message.
  bot.callbackQuery(/^(bpa?):(.+)$/, async (ctx) => {
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const agent = account(env, ctx.user!.tgUserId);
    const [list, { plates }] = await Promise.all([agent.reservations(), agent.profile()]);
    const r = list.find((x) => x.reservationID === ctx.match[2]);
    const v = r ? reservationPlatePicker(r, plates) : { text: "Reservation not found (cancelled?)", keyboard: [] };
    if (ctx.match[1] === "bp") await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
    else await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  });
  bot.callbackQuery(/^bc:(.+):([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const r = (await account(env, ctx.user!.tgUserId).reservations()).find((x) => x.reservationID === ctx.match[1]);
    if (!r) return showBookings(ctx, "Reservation not found (cancelled?)");
    const plate = ctx.match[2]!;
    await ctx.editMessageText(
      `Change plate for <b>${lotName(r.lot)} · ${prettyDate(r.date)}</b>: ${esc(r.plate || "none")} → <b>${esc(plate)}</b>?`,
      { parse_mode: "HTML", ...markup([[{ text: "Yes, change", callback_data: `bpy:${r.reservationID}:${plate}` }, { text: "Keep", callback_data: "bl" }]]) },
    );
  });
  bot.callbackQuery(/^bpy:(.+):([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Changing plate…");
    const r = await account(env, ctx.user!.tgUserId).changePlate(ctx.match[1]!, ctx.match[2]!);
    const header = r.ok
      ? `✅ ${lotName(r.reservation.lot)} · ${prettyDate(r.reservation.date)} is now on <b>${esc(r.reservation.plate)}</b>.`
      : `❌ ${esc(r.error)}`;
    await showBookings(ctx, header);
  });
  bot.callbackQuery("bl", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBookings(ctx);
  });

  bot.callbackQuery(/^bx:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Cancel this reservation? You'll be refunded if it's before 8:00am on the day.", markup([[
      { text: "Yes, cancel it", callback_data: `by:${ctx.match[1]}` },
      { text: "Keep it", callback_data: "nop" },
    ]]));
  });
  bot.callbackQuery(/^by:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelling…");
    const r = await account(env, ctx.user!.tgUserId).cancel(ctx.match[1]!);
    await ctx.editMessageText(r.ok ? `✅ Cancelled ${lotName(r.reservation.lot)} · ${prettyDate(r.reservation.date)}.` : `❌ ${r.error}`);
  });

  // ---------- /settings ----------

  bot.command("settings", async (ctx) => {
    const v = settingsView(ctx.user!, prefsOf(ctx.user!));
    await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  });

  async function refreshSettings(ctx: Ctx, toast?: string) {
    await ctx.answerCallbackQuery(toast);
    const u = (await getUser(ctx.d, ctx.user!.tgUserId))!;
    const v = settingsView(u, prefsOf(u));
    await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) }).catch(() => {});
  }

  async function showPlates(ctx: Ctx, header = "", plates?: { plate: string; nickname: string }[]) {
    const u = (await getUser(ctx.d, ctx.user!.tgUserId))!;
    const list = plates ?? (await account(env, u.tgUserId).profile()).plates;
    const v = platesView(list, u.defaultPlate, header);
    if (ctx.callbackQuery) await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.keyboard) }).catch(() => {});
    else await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.keyboard) });
  }

  bot.callbackQuery("sp", async (ctx) => {
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await showPlates(ctx);
  });
  bot.callbackQuery("sb", (ctx) => refreshSettings(ctx));
  bot.callbackQuery(/^pl:(.+)$/, async (ctx) => {
    await ctx.d.update(users).set({ defaultPlate: ctx.match[1]!, updatedAt: now() }).where(eq(users.tgUserId, ctx.user!.tgUserId));
    await ctx.answerCallbackQuery(`Default plate: ${ctx.match[1]}`);
    await showPlates(ctx);
  });
  bot.callbackQuery("pa", async (ctx) => {
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    ui.awaiting = { kind: "plate" };
    await saveUi(ctx.d, ctx.user!.tgUserId, ui);
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the plate number (letters and digits, e.g. <code>ABC123</code>), or /cancel.", { parse_mode: "HTML" });
  });
  bot.callbackQuery(/^pr:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plate = ctx.match[1]!;
    await ctx.editMessageText(`Remove <b>${esc(plate)}</b> from your Inflow account?`, {
      parse_mode: "HTML",
      ...markup([[{ text: "Remove", callback_data: `pry:${plate}` }, { text: "Keep", callback_data: "sp" }]]),
    });
  });
  bot.callbackQuery(/^pry:(.+)$/, async (ctx) => {
    if (!(await requireActive(ctx))) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery("Removing…");
    const plate = ctx.match[1]!;
    const r = await account(env, ctx.user!.tgUserId).removePlate(plate);
    if (!r.ok) return showPlates(ctx, `❌ ${esc(r.error)}`);
    if (ctx.user!.defaultPlate === plate) {
      await ctx.d.update(users).set({ defaultPlate: null, updatedAt: now() }).where(eq(users.tgUserId, ctx.user!.tgUserId));
    }
    await showPlates(ctx, `🗑 Removed ${esc(plate)}.`, r.plates);
  });
  bot.callbackQuery(/^sc:(.+)$/, async (ctx) => {
    const prefs = prefsOf(ctx.user!);
    const lot = ctx.match[1]!;
    prefs.carpool = { ...prefs.carpool, [lot]: !prefs.carpool?.[lot] };
    await savePrefs(ctx.d, ctx.user!.tgUserId, prefs);
    await refreshSettings(ctx);
  });
  bot.callbackQuery(/^sk:(.+)$/, async (ctx) => {
    const lot = ctx.match[1]!;
    if (!isLot(lot)) return ctx.answerCallbackQuery();
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    ui.awaiting = { kind: "accessKey", lot };
    await saveUi(ctx.d, ctx.user!.tgUserId, ui);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send your <b>${lotName(lot)}</b> access key / passholder code (or /cancel).`, { parse_mode: "HTML" });
  });
  bot.callbackQuery(/^skc:(.+)$/, async (ctx) => {
    const prefs = prefsOf(ctx.user!);
    if (prefs.accessKeys) delete prefs.accessKeys[ctx.match[1]!];
    await savePrefs(ctx.d, ctx.user!.tgUserId, prefs);
    await refreshSettings(ctx, "Removed");
  });
  bot.callbackQuery("rl", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Log in again:", markup(loginKeyboard(env.PUBLIC_URL)));
  });
  bot.callbackQuery("lo", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Log out and delete everything (credentials, watches, history)? This can't be undone.", markup([[
      { text: "Yes, wipe my data", callback_data: "loy" },
      { text: "No", callback_data: "nop" },
    ]]));
  });
  bot.callbackQuery("loy", async (ctx) => {
    const id = ctx.user!.tgUserId;
    await account(env, id).wipe();
    await ctx.d.delete(events).where(eq(events.tgUserId, id));
    await ctx.d.delete(uiState).where(eq(uiState.tgUserId, id));
    await ctx.d.delete(users).where(eq(users.tgUserId, id)); // cascades watches + bookings
    await ctx.answerCallbackQuery("Done");
    await ctx.editMessageText("🚪 Logged out and wiped. Your Inflow reservations themselves are untouched. /start to come back (invite needed).");
  });

  bot.command("cancel", async (ctx) => {
    await saveUi(ctx.d, ctx.user!.tgUserId, {});
    await ctx.reply("OK.");
  });

  // ---------- /status ----------

  bot.command("status", async (ctx) => {
    const [acct, sc, kill, mine] = await Promise.all([
      account(env, ctx.user!.tgUserId).health(),
      scout(env).health(),
      getConfig(ctx.d, "kill_switch"),
      myWatches(ctx),
    ]);
    const active = mine.filter((w) => w.status === "active");
    const infos = await Promise.all(active.slice(0, 10).map((w) => monitor(env, w.lot, w.date).info().catch(() => null)));
    const lines = [
      "<b>Status</b>",
      `Inflow login: ${acct.connected ? (ctx.user!.status === "active" ? "✅" : "⚠️ needs re-login") : "❌ not connected"}`,
      `Scout: ${sc.healthy ? "✅" : "⚠️ degraded"}${kill === "1" ? " · 🛑 kill switch ON" : ""}`,
      acct.pendingPayment ? `⏳ Payment pending: ${lotName(acct.pendingPayment.lot)} ${prettyDate(acct.pendingPayment.date)}` : "",
      `Watches: ${active.length} active, ${mine.filter((w) => w.status === "paused").length} paused`,
      ...active.slice(0, 10).map((w, i) => {
        const inf = infos[i];
        const next = inf?.nextAt ? `next poll in ${Math.max(0, Math.round((inf.nextAt - Date.now()) / 1000))}s` : "starting";
        return `• ${prettyDate(w.date)} ${lotName(w.lot)} — ${inf?.lastStatus ?? "?"} · ${next}`;
      }),
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ---------- admin ----------

  const isAdmin = (ctx: Ctx) => ctx.user?.role === "admin";
  const adminKb = (kill: boolean): Keyboard => [
    [{ text: "➕ Invite", callback_data: "ai" }, { text: "👥 Users", callback_data: "au" }],
    [{ text: "🕒 Release windows", callback_data: "aw" }, { text: "🛰 Scout re-login", callback_data: "as" }],
    [{ text: kill ? "▶️ Resume all (kill switch ON)" : "🛑 Kill switch", callback_data: "ak" }],
  ];

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const kill = (await getConfig(ctx.d, "kill_switch")) === "1";
    await ctx.reply("<b>Admin</b>", { parse_mode: "HTML", ...markup(adminKb(kill)) });
  });

  bot.callbackQuery(/^(ai|au|aw|as|ak|ud:.+|awt:.+)$/, async (ctx, next) => (isAdmin(ctx) ? next() : ctx.answerCallbackQuery()));

  bot.callbackQuery("ai", async (ctx) => {
    const code = randomId(8);
    await ctx.d.insert(invites).values({ code, createdBy: ctx.user!.tgUserId, createdAt: now() });
    await ctx.answerCallbackQuery();
    await ctx.reply(`One-time invite link:\nhttps://t.me/${ctx.me.username}?start=${code}`);
  });
  bot.callbackQuery("au", async (ctx) => {
    await ctx.answerCallbackQuery();
    const all = await ctx.d.select().from(users).orderBy(desc(users.createdAt)).all();
    await ctx.reply(
      "<b>Users</b>\n" + all.map((u) => `${u.status === "disabled" ? "🚫" : "✅"} ${esc(u.name)} · ${u.role} · ${u.status}`).join("\n"),
      { parse_mode: "HTML", ...markup(all.filter((u) => u.role !== "admin").map((u) => [{ text: `${u.status === "disabled" ? "Enable" : "Disable"} ${u.name}`, callback_data: `ud:${u.tgUserId}` }])) },
    );
  });
  bot.callbackQuery(/^ud:(\d+)$/, async (ctx) => {
    const u = await getUser(ctx.d, Number(ctx.match[1]));
    if (u) await ctx.d.update(users).set({ status: u.status === "disabled" ? "active" : "disabled", updatedAt: now() }).where(eq(users.tgUserId, u.tgUserId));
    await ctx.answerCallbackQuery("Updated");
  });
  async function windowsView(ctx: Ctx) {
    const ws = await ctx.d.select().from(releaseWindows).orderBy(releaseWindows.lot).all();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const label = (w: (typeof ws)[number]) =>
      `${lotName(w.lot)} ${w.kind === "weekly" ? `${days[w.weekday ?? 0]} ${w.localTime}` : `${w.daysBefore}d before ${w.localTime}`}`;
    return {
      text: "<b>Release windows</b> (5s polling from −2 to +15 min)\nAdd: <code>/addwindow alta weekly 0 15:00</code> or <code>/addwindow brighton before 1 08:00</code>",
      kb: ws.map((w) => [{ text: `${w.enabled ? "✅" : "⬜️"} ${label(w)}`, callback_data: `awt:${w.id}` }]),
    };
  }
  bot.callbackQuery("aw", async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = await windowsView(ctx);
    await ctx.reply(v.text, { parse_mode: "HTML", ...markup(v.kb) });
  });
  bot.callbackQuery(/^awt:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const w = await ctx.d.select().from(releaseWindows).where(eq(releaseWindows.id, id)).get();
    if (w) await ctx.d.update(releaseWindows).set({ enabled: w.enabled ? 0 : 1 }).where(eq(releaseWindows.id, id));
    await ctx.answerCallbackQuery("Toggled");
    const v = await windowsView(ctx);
    await ctx.editMessageText(v.text, { parse_mode: "HTML", ...markup(v.kb) });
  });
  bot.command("addwindow", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const m = ctx.match.trim().match(/^(\S+)\s+(weekly|before)\s+(\d+)\s+(\d{2}:\d{2})$/);
    if (!m || !isLot(m[1]!)) return ctx.reply("Usage: /addwindow <lot> weekly <0-6, 0=Sun> <HH:MM>  |  /addwindow <lot> before <days> <HH:MM>");
    await ctx.d.insert(releaseWindows).values({
      lot: m[1]!,
      kind: m[2] === "weekly" ? "weekly" : "days_before",
      weekday: m[2] === "weekly" ? Number(m[3]) : null,
      daysBefore: m[2] === "before" ? Number(m[3]) : null,
      localTime: m[4]!,
    });
    await ctx.reply("Added.");
  });
  bot.callbackQuery("as", async (ctx) => {
    await ctx.answerCallbackQuery("Re-logging in…");
    try {
      const h = await scout(env).relogin();
      await ctx.reply(`🛰 Scout OK. Token valid until ${new Date((h.idTokenExp ?? 0) * 1000).toISOString()}`);
    } catch (e) {
      await ctx.reply(`🛰 Scout login failed: ${esc(String(e))}`);
    }
  });
  bot.callbackQuery("ak", async (ctx) => {
    const kill = (await getConfig(ctx.d, "kill_switch")) === "1";
    await setConfig(ctx.d, "kill_switch", kill ? "0" : "1");
    await ctx.answerCallbackQuery(kill ? "Resumed" : "Kill switch ON — all polling & booking stopped");
    await ctx.editMessageReplyMarkup(markup(adminKb(!kill)));
  });

  // ---------- free text (access key entry) ----------

  bot.on("message:text", async (ctx) => {
    const ui = await loadUi(ctx.d, ctx.user!.tgUserId);
    if (ui.awaiting?.kind === "accessKey") {
      const prefs = prefsOf(ctx.user!);
      prefs.accessKeys = { ...prefs.accessKeys, [ui.awaiting.lot]: ctx.message.text.trim() };
      await savePrefs(ctx.d, ctx.user!.tgUserId, prefs);
      const lot = ui.awaiting.lot;
      delete ui.awaiting;
      await saveUi(ctx.d, ctx.user!.tgUserId, ui);
      await ctx.deleteMessage().catch(() => {});
      return ctx.reply(`🔑 Saved your ${lotName(lot)} access key. I'll apply it when booking.`);
    }
    if (ui.awaiting?.kind === "plate") {
      const plate = normalizePlate(ctx.message.text);
      if (!plate) return ctx.reply("That doesn't look like a plate: use 2–12 letters and digits. Try again, or /cancel.");
      delete ui.awaiting;
      await saveUi(ctx.d, ctx.user!.tgUserId, ui);
      await ctx.replyWithChatAction("typing");
      const r = await account(env, ctx.user!.tgUserId).addPlate(plate);
      if (!r.ok) return ctx.reply(`❌ ${esc(r.error)} Nothing was saved.`, { parse_mode: "HTML" });
      let header = `✅ Added <b>${esc(plate)}</b> to your Inflow account.`;
      if (!ctx.user!.defaultPlate) {
        await ctx.d.update(users).set({ defaultPlate: plate, updatedAt: now() }).where(eq(users.tgUserId, ctx.user!.tgUserId));
        header += " It's your default plate.";
      }
      return showPlates(ctx, header, r.plates);
    }
    await ctx.reply(HELP, { parse_mode: "HTML" });
  });

  bot.catch((err) => {
    console.error(JSON.stringify({ event: "bot_error", error: String(err.error), stack: (err.error as Error)?.stack }));
    err.ctx.reply("😵 Something went wrong. Try again in a moment.").catch(() => {});
  });

  return bot;
}

export async function handleWebhook(req: Request, env: Env, exec: ExecutionContext) {
  const bot = makeBot(env, exec);
  if (!botInfo) {
    await bot.init();
    botInfo = bot.botInfo;
  }
  return webhookCallback(bot, "cloudflare-mod", {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    timeoutMilliseconds: 25_000,
    onTimeout: "return",
  })(req);
}
