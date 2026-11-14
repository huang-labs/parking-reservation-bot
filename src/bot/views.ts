/** Message text + inline keyboards. Pure functions (no I/O) so they're easy to test. */
import { canChangePlate } from "../core/plates";
import { prettyDate, TZ } from "../core/time";
import type { User, UserPrefs, Watch } from "../db/schema";
import type { Reservation } from "../do/account";
import { type AvailabilityStatus, LOTS, type LotKey } from "../inflow/client";
import { type Button, esc, type Keyboard } from "../telegram";

export const CARPOOL_LOTS: LotKey[] = ["brighton", "solitude", "solitude-nordic"];
export const lotName = (lot: string) => LOTS[lot as LotKey]?.name ?? lot;
const cb = (text: string, data: string): Button => ({ text, callback_data: data });

export const HELP = [
  "<b>Commands</b>",
  "/watch — watch sold-out dates and auto-book when a spot opens",
  "/watches — your watches",
  "/bookings — your upcoming Inflow reservations",
  "/settings — plates, passes, carpool, logout",
  "/status — health and next polls",
].join("\n");

export function loginKeyboard(publicUrl: string): Keyboard {
  return [[{ text: "🔐 Log in to Inflow", web_app: { url: `${publicUrl}/miniapp/login` } }]];
}

export function lotPicker(): Keyboard {
  return [
    [cb("Alta", "wl:alta"), cb("Brighton", "wl:brighton")],
    [cb("Solitude", "wl:solitude"), cb("Solitude Nordic", "wl:solitude-nordic")],
  ];
}

export interface WatchDraft {
  lot: LotKey;
  month: string;
  selected: string[];
  mode: "auto" | "notify";
  /** null = use the user's default for this lot */
  carpool: boolean | null;
  /** null = use the user's default plate */
  plate?: string | null;
}

const MARK: Partial<Record<AvailabilityStatus | string, string>> = {
  Available: "🟢",
  Full: "🔴",
  FullButNotAllConfirmed: "🟡",
};

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function calendarView(args: {
  draft: WatchDraft;
  availability: Record<string, { availabilityStatus: string }> | null;
  watched: Set<string>;
  today: string;
  prefs: UserPrefs;
  defaultPlate?: string | null;
}): { text: string; keyboard: Keyboard } {
  const { draft, availability, watched, today, prefs, defaultPlate = null } = args;
  const [y, m] = draft.month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = first.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" });

  const kb: Keyboard = [
    [cb("‹", `wc:${shiftMonth(draft.month, -1)}`), cb(monthLabel, "nop"), cb("›", `wc:${shiftMonth(draft.month, 1)}`)],
    ["S", "M", "T", "W", "T", "F", "S"].map((d) => cb(d, "nop")),
  ];
  let row: Button[] = Array.from({ length: first.getUTCDay() }, () => cb(" ", "nop"));
  for (let day = 1; day <= days; day++) {
    const date = `${draft.month}-${String(day).padStart(2, "0")}`;
    const status = availability?.[date]?.availabilityStatus;
    const past = date < today;
    const selectable = !past && status !== "NoInventoryActive" && status !== "Closed" && status !== "NotRequired";
    let label = String(day);
    if (draft.selected.includes(date)) label += "✅";
    else if (watched.has(date)) label += "👀";
    else if (past || !selectable) label = "·";
    else label += MARK[status ?? ""] ?? "";
    row.push(cb(label, selectable ? `wd:${date}` : "nop"));
    if (row.length === 7) {
      kb.push(row);
      row = [];
    }
  }
  if (row.length) kb.push([...row, ...Array.from({ length: 7 - row.length }, () => cb(" ", "nop"))]);

  const opts: Button[] = [cb(draft.mode === "auto" ? "⚡ Mode: auto-book" : "🔔 Mode: notify", "wm")];
  if (CARPOOL_LOTS.includes(draft.lot)) {
    const def = Boolean(prefs.carpool?.[draft.lot]);
    const eff = draft.carpool ?? def;
    opts.push(cb(`🚗 Carpool: ${eff ? "yes" : "no"}${draft.carpool === null ? " (default)" : ""}`, "wcp"));
  }
  kb.push(opts);
  kb.push([cb(draft.plate ? `🚘 Plate: ${draft.plate}` : defaultPlate ? `🚘 Plate: ${defaultPlate} (default)` : "🚘 Plate: none", "wpl")]);
  kb.push([cb("↩︎ Lots", "wback"), cb(draft.selected.length ? `✅ Watch ${draft.selected.length} date${draft.selected.length > 1 ? "s" : ""}` : "Pick dates", "wok")]);

  const text = [
    `<b>${lotName(draft.lot)}</b> — tap dates to watch.`,
    "🟢 open · 🔴 full · 🟡 full (unpaid holds may free up) · 👀 watching · · n/a",
    availability ? "" : "<i>(availability unavailable right now — you can still pick dates)</i>",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, keyboard: kb };
}

const STATUS_ICON: Record<string, string> = { active: "👀", paused: "⏸", booking: "⏳", booked: "🎉" };

export function watchesView(list: Watch[]): { text: string; keyboard: Keyboard } {
  if (!list.length) return { text: "No watches yet. /watch to add some.", keyboard: [] };
  const lines = ["<b>Your watches</b>"];
  const kb: Keyboard = [];
  for (const w of list) {
    const label = `${prettyDate(w.date)} · ${lotName(w.lot)}`;
    lines.push(
      `${STATUS_ICON[w.status] ?? "•"} ${label} · ${w.mode === "auto" ? "auto-book" : "notify"}` +
        (w.status === "paused" && w.pauseReason ? ` · <i>${esc(w.pauseReason)}</i>` : ""),
    );
    if (w.status === "booked") continue;
    kb.push([
      w.status === "paused" ? cb(`▶️ ${label}`, `wr:${w.id}`) : cb(`⏸ ${label}`, `wp:${w.id}`),
      cb(w.mode === "auto" ? "→🔔" : "→⚡", `wt:${w.id}`),
      cb("🗑", `wx:${w.id}`),
    ]);
  }
  return { text: lines.join("\n"), keyboard: kb };
}

/** Short lot label that fits a half-width inline button on a phone. */
const shortLot = (lot: string) => lotName(lot).replace("Solitude ", "Sol. ");

/** Telegram splits a row's width evenly and middle-truncates long labels, so keep toggle rows to two buttons. */
const rowsOf = <T>(items: T[], size = 2): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export function settingsView(user: User, prefs: UserPrefs): { text: string; keyboard: Keyboard } {
  const keys = prefs.accessKeys ?? {};
  const lines = [
    "<b>Settings</b>",
    `Inflow: ${esc(user.inflowEmail ?? "not connected")}`,
    `🚘 Default plate: <b>${esc(user.defaultPlate ?? "none")}</b>`,
    "",
    `🚗 <b>Carpool (4+)</b>: ${CARPOOL_LOTS.filter((l) => prefs.carpool?.[l]).map(lotName).join(", ") || "none"}`,
    "Tap a ⬜️/☑️ lot to prefer carpool rates there.",
    "",
    `🔑 <b>Access keys</b>: ${(Object.keys(LOTS) as LotKey[]).filter((k) => keys[k]).map(lotName).join(", ") || "none"}`,
    "Tap a 🔑 lot to add its passholder code, or ✕ to remove it.",
  ];
  const kb: Keyboard = [
    [cb("🚘 Plates", "sp")],
    ...rowsOf(CARPOOL_LOTS.map((l) => cb(`${prefs.carpool?.[l] ? "☑️" : "⬜️"} ${shortLot(l)}`, `sc:${l}`))),
    ...rowsOf(
      (Object.keys(LOTS) as LotKey[]).map((l) =>
        keys[l] ? cb(`🔑 ${shortLot(l)} ✕`, `skc:${l}`) : cb(`🔑 ${shortLot(l)}`, `sk:${l}`),
      ),
    ),
    [cb("🔐 Re-login", "rl"), cb("🚪 Logout & wipe", "lo")],
  ];
  return { text: lines.join("\n"), keyboard: kb };
}

type PlateOption = { plate: string; nickname: string };
const plateLabel = (p: PlateOption) => `${p.plate}${p.nickname ? ` (${p.nickname})` : ""}`;

/** /settings → Plates: the Inflow account's saved plates, the default, add and remove. */
export function platesView(plates: PlateOption[], defaultPlate: string | null, header = ""): { text: string; keyboard: Keyboard } {
  const lines = [
    header,
    "<b>🚘 Plates</b> (saved on your Inflow account)",
    plates.length ? "Tap a plate to make it the default." : "No saved plates yet. Add one below.",
    plates.length && !(defaultPlate && plates.some((p) => p.plate === defaultPlate)) ? "<i>No default plate: tap one to set it.</i>" : "",
  ];
  const kb: Keyboard = plates.map((p) => [
    p.plate === defaultPlate ? cb(`⭐ ${plateLabel(p)} · default`, "nop") : cb(plateLabel(p), `pl:${p.plate}`),
    cb("🗑", `pr:${p.plate}`),
  ]);
  kb.push([cb("➕ Add plate", "pa"), cb("↩︎ Back", "sb")]);
  return { text: lines.filter(Boolean).join("\n"), keyboard: kb };
}

/** /watch → 🚘 Plate: default or one saved plate for the dates being added. Adding plates happens in /settings. */
export function watchPlatePicker(plates: PlateOption[], defaultPlate: string | null, chosen: string | null): { text: string; keyboard: Keyboard } {
  const kb: Keyboard = [];
  if (defaultPlate) kb.push([cb(`${chosen ? "" : "✅ "}Default (${defaultPlate})`, "wps:")]);
  for (const p of plates) {
    if (p.plate === defaultPlate) continue;
    kb.push([cb(`${chosen === p.plate ? "✅ " : ""}${plateLabel(p)}`, `wps:${p.plate}`)]);
  }
  kb.push([cb("↩︎ Back", "wpb")]);
  const text = kb.length > 1 ? "Which plate should I book these dates with?" : "No plates to pick from. Add one in /settings.";
  return { text, keyboard: kb };
}

const DAY_SHORT = (date: string) => prettyDate(date).replace(/^\w+, /, ""); // "Sun, Apr 25" → "Apr 25"
const localTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

/** /bookings: upcoming reservations with plate-change and cancel buttons. */
export function bookingsView(list: Reservation[], now = Date.now(), header = ""): { text: string; keyboard: Keyboard } {
  if (!list.length) return { text: [header, "No upcoming reservations."].filter(Boolean).join("\n\n"), keyboard: [] };
  const lines = [header, "<b>Upcoming reservations</b>"].filter(Boolean);
  const kb: Keyboard = [];
  const dateCount = new Map<string, number>();
  for (const r of list) dateCount.set(r.date, (dateCount.get(r.date) ?? 0) + 1);
  for (const r of list) {
    const changeable = canChangePlate(r, now);
    const until = r.allowPlateChangeUntil
      ? localDate(r.allowPlateChangeUntil) === r.date
        ? localTime(r.allowPlateChangeUntil)
        : `${DAY_SHORT(localDate(r.allowPlateChangeUntil))} ${localTime(r.allowPlateChangeUntil)}`
      : "";
    lines.push(
      `🅿️ ${prettyDate(r.date)} · ${lotName(r.lot)} · ${esc(r.plate || "no plate")} · <code>${esc(r.confirmationNumber)}</code>\n` +
        `    ${changeable ? (until ? `plate changeable until ${until}` : "plate changeable") : "plate locked"}`,
    );
    const tag = `${DAY_SHORT(r.date)}${(dateCount.get(r.date) ?? 0) > 1 ? ` ${shortLot(r.lot)}` : ""}`;
    const row: Button[] = [];
    if (changeable) row.push(cb(`🚘 Plate · ${tag}`, `bp:${r.reservationID}`));
    if (!r.blockCancellation) row.push(cb(`❌ Cancel · ${tag}`, `bx:${r.reservationID}`));
    if (row.length) kb.push(row);
  }
  return { text: lines.join("\n") + "\n\nFree cancellation until 8:00am on the day.", keyboard: kb };
}

/** /bookings → 🚘 Plate: pick one of the saved plates for a reservation. */
export function reservationPlatePicker(r: Reservation, plates: PlateOption[]): { text: string; keyboard: Keyboard } {
  const where = `${lotName(r.lot)} · ${prettyDate(r.date)}`;
  if (!plates.length) return { text: `No saved plates. Add one in /settings.`, keyboard: [[cb("↩︎ Back", "bl")]] };
  const kb: Keyboard = plates.map((p) =>
    p.plate === r.plate ? [cb(`✅ ${plateLabel(p)} · current`, "nop")] : [cb(plateLabel(p), `bc:${r.reservationID}:${p.plate}`)],
  );
  kb.push([cb("↩︎ Back", "bl")]);
  return { text: `🚘 New plate for <b>${where}</b> (now ${esc(r.plate || "none")}):`, keyboard: kb };
}
