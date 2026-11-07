import type { AvailabilityStatus } from "../inflow/client";
import { addDays, localToUtc, watchDeadline, weekdayOf } from "./time";

export interface WindowSpec {
  kind: "weekly" | "days_before";
  weekday?: number | null;
  daysBefore?: number | null;
  localTime: string;
}

export const CADENCE = {
  burstMs: 5_000,
  nearMs: 15_000,
  baseMs: 60_000,
  idleMs: 300_000,
  windowBeforeMs: 2 * 60_000,
  windowAfterMs: 15 * 60_000,
} as const;

/** Release instants (UTC ms) relevant to a watch on `date`, within [from, until]. */
export function releaseInstants(date: string, windows: WindowSpec[], from: number, until: number): number[] {
  const out: number[] = [];
  for (const w of windows) {
    if (w.kind === "days_before" && w.daysBefore != null) {
      out.push(localToUtc(addDays(date, -w.daysBefore), w.localTime));
    } else if (w.kind === "weekly" && w.weekday != null) {
      // every matching weekday between (from - 1 day) and the watch date
      const last = new Date(until + 86_400_000).toISOString().slice(0, 10);
      let d = new Date(from - 86_400_000).toISOString().slice(0, 10);
      for (; d <= date && d <= last; d = addDays(d, 1)) {
        if (weekdayOf(d) === w.weekday) out.push(localToUtc(d, w.localTime));
      }
    }
  }
  return out.filter((t) => t + CADENCE.windowAfterMs >= from && t - CADENCE.windowBeforeMs <= until).sort((a, b) => a - b);
}

/** Delay until the next poll for a (lot, date) monitor. */
export function nextPollDelay(args: {
  now: number;
  date: string;
  windows: WindowSpec[];
  lastStatus?: AvailabilityStatus | string;
}): number {
  const { now, date, windows, lastStatus } = args;
  const deadline = watchDeadline(date);
  const horizon = now + CADENCE.idleMs;
  const instants = releaseInstants(date, windows, now, horizon);

  const inWindow = instants.some((t) => now >= t - CADENCE.windowBeforeMs && now <= t + CADENCE.windowAfterMs);
  if (inWindow) return CADENCE.burstMs;

  let delay: number;
  if (deadline - now <= 24 * 3_600_000) delay = CADENCE.nearMs;
  else if (lastStatus === "FullButNotAllConfirmed") delay = CADENCE.nearMs;
  else if (lastStatus === "ComingSoon" || lastStatus === "Closed" || lastStatus === "NoInventoryActive") delay = CADENCE.idleMs;
  else delay = CADENCE.baseMs;

  // never sleep through the start of a burst window
  const nextStart = instants.map((t) => t - CADENCE.windowBeforeMs).find((s) => s > now);
  if (nextStart !== undefined) delay = Math.min(delay, nextStart - now);
  return Math.max(1_000, delay);
}
