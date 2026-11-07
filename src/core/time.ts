/** America/Denver date/time helpers. Dates are "YYYY-MM-DD" strings. */
export const TZ = "America/Denver";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface LocalParts {
  date: string;
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function localParts(ms: number): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  const h = Number(p.hour), mi = Number(p.minute), s = Number(p.second);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS.indexOf(p.weekday!),
    minutes: h * 60 + mi,
    y, m, d, h, mi, s,
  };
}

function offsetMs(ms: number): number {
  const p = localParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000));
}

/** UTC epoch ms of local wall-clock `hhmm` on local `date`. */
export function localToUtc(date: string, hhmm: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const today = (now = Date.now()) => localParts(now).date;

/** Watches end at 08:00 local on their date (cancellation cut-off). */
export const watchDeadline = (date: string) => localToUtc(date, "08:00");

export function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
