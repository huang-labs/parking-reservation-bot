CREATE TABLE users (
  tg_user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'needs_login', 'disabled')),
  inflow_email TEXT,
  default_plate TEXT,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  tg_user_id INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  lot TEXT NOT NULL,
  date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'notify')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'booking', 'booked', 'expired', 'cancelled')),
  plate_override TEXT,
  carpool_override INTEGER,
  pause_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tg_user_id, lot, date)
);
CREATE INDEX watches_lot_date_status ON watches (lot, date, status);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  watch_id TEXT,
  tg_user_id INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  lot TEXT NOT NULL,
  date TEXT NOT NULL,
  inflow_reservation_id TEXT,
  confirmation_number TEXT,
  receipt_id TEXT,
  rate_name TEXT,
  amount REAL,
  plate TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER,
  watch_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX events_at ON events (at);

CREATE TABLE release_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'days_before')),
  weekday INTEGER,
  days_before INTEGER,
  local_time TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE ui_state (tg_user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- weekday: 0 = Sunday. Times are America/Denver.
INSERT INTO release_windows (lot, kind, weekday, days_before, local_time) VALUES
  ('alta', 'weekly', 0, NULL, '15:00'),
  ('brighton', 'weekly', 1, NULL, '18:00'),
  ('brighton', 'days_before', NULL, 1, '08:00'),
  ('brighton', 'days_before', NULL, 1, '14:00'),
  ('solitude', 'weekly', 0, NULL, '18:00'),
  ('solitude', 'days_before', NULL, 0, '06:00'),
  ('solitude-nordic', 'weekly', 0, NULL, '18:00'),
  ('solitude-nordic', 'days_before', NULL, 0, '06:00'),
  ('alta', 'days_before', NULL, 0, '07:50'),
  ('brighton', 'days_before', NULL, 0, '07:50'),
  ('solitude', 'days_before', NULL, 0, '07:50'),
  ('solitude-nordic', 'days_before', NULL, 0, '07:50');

INSERT INTO config (key, value) VALUES ('kill_switch', '0'), ('scout_status', 'ok');
