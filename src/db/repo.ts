import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { randomId } from "../core/crypto";
import * as t from "./schema";

export const db = (d1: D1Database) => drizzle(d1, { schema: t });
export type DB = ReturnType<typeof db>;

export const now = () => Date.now();

export async function getUser(d: DB, tgUserId: number) {
  return (await d.select().from(t.users).where(eq(t.users.tgUserId, tgUserId)).get()) ?? null;
}

export function prefsOf(u: Pick<t.User, "prefsJson">): t.UserPrefs {
  try {
    return JSON.parse(u.prefsJson) as t.UserPrefs;
  } catch {
    return {};
  }
}

export async function getConfig(d: DB, key: string): Promise<string | null> {
  return (await d.select().from(t.config).where(eq(t.config.key, key)).get())?.value ?? null;
}

export async function setConfig(d: DB, key: string, value: string) {
  await d.insert(t.config).values({ key, value }).onConflictDoUpdate({ target: t.config.key, set: { value } });
}

export async function logEvent(d: DB, kind: string, detail: unknown, ids: { tgUserId?: number; watchId?: string } = {}) {
  console.log(JSON.stringify({ event: kind, ...ids, detail }));
  await d.insert(t.events).values({
    kind,
    detailJson: JSON.stringify(detail ?? {}),
    tgUserId: ids.tgUserId ?? null,
    watchId: ids.watchId ?? null,
    at: now(),
  });
}

export async function getWatch(d: DB, id: string) {
  return (await d.select().from(t.watches).where(eq(t.watches.id, id)).get()) ?? null;
}

/** Atomically move a watch between statuses; returns true if this caller won the transition. */
export async function transitionWatch(
  d: DB,
  id: string,
  from: t.WatchStatus[],
  to: t.WatchStatus,
  extra: Partial<Pick<t.Watch, "pauseReason">> = {},
): Promise<boolean> {
  const res = await d
    .update(t.watches)
    .set({ status: to, updatedAt: now(), pauseReason: extra.pauseReason ?? null })
    .where(and(eq(t.watches.id, id), inArray(t.watches.status, from)))
    .returning({ id: t.watches.id });
  return res.length > 0;
}

/** Create (or re-activate) a watch. */
export async function upsertWatch(
  d: DB,
  w: { tgUserId: number; lot: string; date: string; mode: "auto" | "notify"; carpoolOverride?: boolean | null; plateOverride?: string | null },
): Promise<t.Watch> {
  const ts = now();
  const rows = await d
    .insert(t.watches)
    .values({
      id: randomId(),
      tgUserId: w.tgUserId,
      lot: w.lot,
      date: w.date,
      mode: w.mode,
      status: "active",
      carpoolOverride: w.carpoolOverride == null ? null : Number(w.carpoolOverride),
      plateOverride: w.plateOverride ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [t.watches.tgUserId, t.watches.lot, t.watches.date],
      set: {
        mode: w.mode,
        status: "active",
        pauseReason: null,
        carpoolOverride: w.carpoolOverride == null ? null : Number(w.carpoolOverride),
        plateOverride: w.plateOverride ?? null,
        updatedAt: ts,
      },
    })
    .returning();
  return rows[0]!;
}

export async function activeWatchesFor(d: DB, lot: string, date: string) {
  return d
    .select({ watch: t.watches, user: t.users })
    .from(t.watches)
    .innerJoin(t.users, eq(t.users.tgUserId, t.watches.tgUserId))
    .where(and(eq(t.watches.lot, lot), eq(t.watches.date, date), eq(t.watches.status, "active"), eq(t.users.status, "active")))
    .all();
}

export async function getWindows(d: DB, lot: string) {
  return d
    .select()
    .from(t.releaseWindows)
    .where(and(eq(t.releaseWindows.lot, lot), eq(t.releaseWindows.enabled, 1)))
    .all();
}
