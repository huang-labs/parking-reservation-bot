import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Mirrors migrations/0001_init.sql (hand-written SQL is the source of truth for DDL). */

export const users = sqliteTable("users", {
  tgUserId: integer("tg_user_id").primaryKey(),
  chatId: integer("chat_id").notNull(),
  name: text("name").notNull().default(""),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["new", "active", "needs_login", "disabled"] }).notNull().default("new"),
  inflowEmail: text("inflow_email"),
  defaultPlate: text("default_plate"),
  prefsJson: text("prefs_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const invites = sqliteTable("invites", {
  code: text("code").primaryKey(),
  createdBy: integer("created_by").notNull(),
  usedBy: integer("used_by"),
  createdAt: integer("created_at").notNull(),
  usedAt: integer("used_at"),
});

export const WATCH_STATUSES = ["active", "paused", "booking", "booked", "expired", "cancelled"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export const watches = sqliteTable("watches", {
  id: text("id").primaryKey(),
  tgUserId: integer("tg_user_id").notNull(),
  lot: text("lot").notNull(),
  date: text("date").notNull(),
  mode: text("mode", { enum: ["auto", "notify"] }).notNull().default("auto"),
  status: text("status", { enum: WATCH_STATUSES }).notNull().default("active"),
  plateOverride: text("plate_override"),
  carpoolOverride: integer("carpool_override"),
  pauseReason: text("pause_reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  watchId: text("watch_id"),
  tgUserId: integer("tg_user_id").notNull(),
  lot: text("lot").notNull(),
  date: text("date").notNull(),
  inflowReservationId: text("inflow_reservation_id"),
  confirmationNumber: text("confirmation_number"),
  receiptId: text("receipt_id"),
  rateName: text("rate_name"),
  amount: real("amount"),
  plate: text("plate"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tgUserId: integer("tg_user_id"),
  watchId: text("watch_id"),
  kind: text("kind").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  at: integer("at").notNull(),
});

export const releaseWindows = sqliteTable("release_windows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lot: text("lot").notNull(),
  kind: text("kind", { enum: ["weekly", "days_before"] }).notNull(),
  weekday: integer("weekday"),
  daysBefore: integer("days_before"),
  localTime: text("local_time").notNull(),
  enabled: integer("enabled").notNull().default(1),
});

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const uiState = sqliteTable("ui_state", {
  tgUserId: integer("tg_user_id").primaryKey(),
  json: text("json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Watch = typeof watches.$inferSelect;
export type ReleaseWindow = typeof releaseWindows.$inferSelect;

export interface UserPrefs {
  /** Passholder / discount access keys per lot, applied via /apply-code. */
  accessKeys?: Partial<Record<string, string>>;
  /** Prefer 4+ carpool rates at this lot. */
  carpool?: Partial<Record<string, boolean>>;
}
