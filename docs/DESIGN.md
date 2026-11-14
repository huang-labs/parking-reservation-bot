# Parking Reservation Bot — Design

Status: agreed 2026-11-07 (grilling session). Facts about the vendor live in
[`research/inflow-api.md`](research/inflow-api.md); this doc records decisions.

## 1. Goal

A Telegram bot that watches sold-out parking dates at Alta, Brighton, and Solitude and
grabs a spot the moment one frees up (cancellation, expired hold, or scheduled release),
booking it on the user's own Inflow account.

All four in-scope lots run on one vendor (Inflow, `reserve.prod.inflowservice.com`):

| Lot key | `qr` | Notes |
|---|---|---|
| `alta` | `altaparking` | Max 4 active reservations/account. Passholder access key → free. |
| `brighton` | `ParkBrightonResort` | 5 per plate, 2 plates/account. 4+ carpool $10. |
| `solitude` | `ParkSolitude` | Moonbeam. Max 3 active. 4+ carpool free (card hold). |
| `solitude-nordic` | `ParkSolitudeNordic` | Max 3 active. |

Out of scope: Alta early-morning (Honk), date ranges, cross-resort fallback lists.

## 2. Decisions

| # | Decision |
|---|---|
| Users | Invite-only, ≤ ~20 users. Owner is admin. Join via `/start <invite-code>`. |
| Credentials | Login via a Telegram **Mini App** served by the Worker (password never in chat). Store Cognito refresh token **and** AES-GCM-encrypted password (key = Worker secret); token first, password re-login fallback. `/logout` wipes everything. |
| Watch | Exactly one `(lot, date)`. Multiple dates can be added in one flow. Mode: `auto` (default) or `notify` (alert + "Book now" button). |
| Contention | When a spot appears, every watcher's agent fires **in parallel**; Inflow arbitrates. |
| ToS | Automation violates Inflow ToS. Accepted moderate risk. Traffic stays human-paced and deduplicated (one poll per lot-date regardless of watcher count). If a captcha ever appears, we do not solve it — degrade to notify mode. |
| Payment | Hold → try headless Stripe confirm with saved card → if `requires_action` (3DS) or failure, push "💳 Pay now" with hold countdown. Free rates skip Stripe. |
| Rate prefs | Per-user prefs (pass access keys, carpool per lot); watch may override. Bot picks the cheapest rate the user qualifies for. |
| Plate | The list of saved plates lives only on Inflow (`savedPlates`); the bot adds and removes them there and stores none itself. The bot keeps one default plate per user, and a watch may set its own plate when it is created. A booked reservation's plate changes through Inflow `/plate-update`. |
| Polling identity | A dedicated **scout** Inflow account does all availability reads. If it fails, polling pauses and admin is alerted; never fall back to friends' accounts. |
| Storage | D1 = system of record. Durable Objects (SQLite) = live coordination. No KV. |
| Stack | TypeScript, Workers (Paid plan, owner's account), grammY, Drizzle (D1), Vitest + `@cloudflare/vitest-pool-workers`. |
| Environments | Production only. GitHub Actions deploys every push to `main`. PRs run tests and AI review only. Tests never hit live Inflow. |
| Time | All dates/times in `America/Denver`. Dates stored as `YYYY-MM-DD`. |
| Retention | Expired/cancelled watches + events purged after 90 days. Bookings kept until `/logout`. |
| Order of work | **Spike first** (§9). Nothing else is built until it passes. |

### Why D1 and not KV

KV is eventually consistent (up to ~60 s cross-location), last-write-wins with no
transactions or compare-and-set, supports only key/prefix lookup, and caps writes at
~1/s per key. This system's core operations are atomic state transitions
(`active → booking → booked`) under parallel contention and relational queries
("all active watches for lot X on date Y", "my watches"). D1 gives SQL + transactions;
Durable Objects give single-threaded, strongly consistent coordination. KV has no role.

## 3. Architecture

```
Telegram ──webhook──▶ Worker (stateless: grammY router, Mini App HTML, /cron)
                         │
        ┌────────────────┼─────────────────────────┐
        ▼                ▼                         ▼
 LotDateMonitor DO   AccountAgent DO (per user)   ScoutSession DO (singleton)
 (per lot+date with  - Inflow tokens (refresh,     - scout Cognito tokens
  ≥1 active watch)     encrypted password)         - Inflow welcome sessions per lot
 - poll alarm        - serialized booking queue    - global throttle / backoff
 - reads via Scout   - hold → plate → checkout     - health → admin alerts
 - fan-out on open     → pay → confirm
        │                │
        └──────┬─────────┘
               ▼
              D1 (users, watches, bookings, events, config)
```

Cron Trigger (every 5 min) is a safety net only: reconciles D1 active watches against
existing monitors (re-arms lost alarms), expires watches past their deadline, and runs
the retention purge daily.

### 3.1 Worker (stateless)

- `POST /telegram/<secret-path>` — webhook; verify `X-Telegram-Bot-Api-Secret-Token`.
- `GET /miniapp/login` — Mini App HTML. `POST /miniapp/login` — validates Telegram
  `initData` HMAC, forwards credentials to the user's `AccountAgent`.
- `scheduled()` — reconciliation (above).
- Routes callbacks/commands to DOs; never talks to Inflow itself.

### 3.2 `ScoutSession` (singleton DO)

- Holds the scout account's Cognito refresh/ID tokens and one Inflow welcome session
  (90-day JWT) per lot `qr`.
- API: `getAvailability(lot, month)`, `getRates(lot, date)`. Applies a global token
  bucket (default ≤ 1 req/s overall, burst 5) and exponential backoff on 429/5xx.
- Caches `getAvailability` 60 s for the `/watch` calendar UI.
- On auth failure / unexpected response shape: sets `scout_status = degraded`, alerts
  admin, and tells monitors to stop polling until healthy.

### 3.3 `LotDateMonitor` (DO per `lot:date`)

- Created when the first watch for that lot-date is added; self-deletes (clears storage
  and alarm) when no active watches remain.
- Reads its active watches from D1 on every alarm (no mirrored list to drift out of sync).
- `alarm()` → ask Scout for rates on its date → if any rate the watchers might qualify
  for is `Available`, call `AccountAgent.attempt(watchId)` for **every** watcher
  concurrently (`Promise.allSettled`), then reschedule.
- Cadence (computed each alarm from the `release_windows` config table):
  - default 60 s;
  - 15 s within 24 h of the date;
  - 5 s from T−2 min to T+15 min of any release window for the lot;
  - paused when scout degraded or kill switch on.
- Availability signals: `Available` → fire. `FullButNotAllConfirmed` → bump to 15 s
  (holds may lapse). `ComingSoon`/`Closed` → back off to 5 min.

### 3.4 `AccountAgent` (DO per Telegram user)

- Holds that user's Inflow credentials and tokens (DO storage, encrypted password).
- Serializes all Inflow calls for the account (Inflow allows one purchase session per
  account); concurrent `attempt()` calls queue, and attempts for a watch already
  `booked` are no-ops.
- `attempt(watchId)` state machine:

```
idle ─▶ fresh welcome session (POST /welcome, lot qr)
     ─▶ /calendar-availability (sets calendar on session) ─▶ /calendar-rates(date)
     ─▶ choose rate (user prefs / overrides; apply access key via /apply-code if needed)
     ─▶ /select-rate  ── ReservationCapacityReached ──▶ lost (quiet log, stay active)
     ─▶ /plate
     ─▶ /checkout ─▶ paymentFlow?
          ├ free:  /payment-intent (requiresPayment=false) ─▶ /confirm-payment ─▶ BOOKED
          ├ paid:  /payment-intent ─▶ Stripe confirm (saved PM) ─┬ succeeded ─▶ poll /confirm-payment ─▶ BOOKED
          │                                                      └ requires_action/fail ─▶ HANDOFF
          └ setup: /setup-intent ─▶ Stripe confirmSetup ─▶ /confirm-setup-intent ─▶ BOOKED | HANDOFF
HANDOFF: push "⏳ Holding … [💳 Pay now]" — a Worker-served Mini App running Stripe.js with the bot's
         client secret + customer session (handles 3DS via handleNextAction, or lets the user pick a card).
         On success → /confirm-payment → BOOKED. Agent alarm at hold expiry → back to active.
         (An Inflow deep link can't work: the hold lives on the bot's server-side session.)
```

- Error classification:
  - transient (`ReservationCapacityReached`, `ReservationHoldExpired`, 5xx, timeouts)
    → watch stays `active`, quiet event.
  - user-actionable (`MaxConcurrentReservationsReached`, `MaxTotalReservations…`,
    `InvalidPlate`, `MissingPlate`, purchase in progress elsewhere) → watch `paused`,
    user notified with `[▶️ Resume]`.
  - auth (`CognitoTokenExpired` → refresh; refresh fails → password re-login; that
    fails → user `needs_login`, all their watches paused, prompt to re-login).
- In `notify` mode, `attempt()` is replaced by an alert with `[⚡ Book now]`, which runs
  the same machine on tap.

## 4. Data model (D1, sketch)

```sql
users(
  tg_user_id INTEGER PK, tg_chat_id INTEGER, display_name TEXT,
  role TEXT CHECK(role IN ('admin','user')), status TEXT, -- active|needs_login|disabled
  inflow_email TEXT, default_plate TEXT,
  prefs_json TEXT,           -- {accessKeys:{alta:'...'}, carpool:{solitude:true}, quietHours:...}
  created_at, updated_at)
invites(code TEXT PK, created_by INTEGER, used_by INTEGER NULL, expires_at, created_at)
watches(
  id TEXT PK, tg_user_id INTEGER, lot TEXT, date TEXT,          -- YYYY-MM-DD
  mode TEXT CHECK(mode IN ('auto','notify')),
  status TEXT CHECK(status IN ('active','paused','booking','booked','expired','cancelled')),
  plate_override TEXT NULL, rate_override_json TEXT NULL,
  pause_reason TEXT NULL, created_at, updated_at,
  UNIQUE(tg_user_id, lot, date))
bookings(
  id TEXT PK, watch_id TEXT NULL, tg_user_id INTEGER, lot TEXT, date TEXT,
  inflow_reservation_id TEXT, confirmation_number TEXT, receipt_id TEXT,
  rate_name TEXT, amount_cents INTEGER, plate TEXT, status TEXT, created_at)
events(id INTEGER PK, tg_user_id INTEGER NULL, watch_id TEXT NULL, kind TEXT, detail_json TEXT, at)
release_windows(id INTEGER PK, lot TEXT, kind TEXT CHECK(kind IN ('weekly','days_before')),
  weekday INTEGER NULL, days_before INTEGER NULL, local_time TEXT, enabled INTEGER)
config(key TEXT PK, value TEXT)   -- kill_switch, scout_status, poll defaults
```

Secrets never live in D1: Inflow passwords/tokens live only in each `AccountAgent`'s
storage; scout credentials in `ScoutSession` storage (seeded from Worker secrets).

Seed `release_windows`: Alta Sun 15:00; Brighton Mon 18:00, day-before 08:00 & 14:00;
Solitude & Nordic Sun 18:00, day-of 06:00. Plus all lots: day-of 07:45–08:15 (cancel cutoff).

Watch expiry: 08:00 local on the watch date.

## 5. Security

- Worker secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CREDS_ENC_KEY`
  (AES-256-GCM, raw base64), `SCOUT_EMAIL`, `SCOUT_PASSWORD`, `ADMIN_TG_USER_ID`.
- Password encryption: AES-GCM, random 96-bit IV per write, AAD = `tg_user_id`.
- Mini App: verify `initData` HMAC (key = HMAC("WebAppData", bot token)), reject if
  `auth_date` > 5 min old, bind to `user.id`.
- Every bot handler checks `users.status` (unknown users get only the invite prompt).
- `/logout`: delete AccountAgent storage, D1 user rows (watches, bookings, events).

## 6. Bot UX

Commands (registered via `setMyCommands`): `/watch`, `/watches`, `/bookings`,
`/settings`, `/status`, `/help` (+ `/admin` for admin only).

**Onboarding** — `/start <code>`:
1. "Welcome! First, connect your Inflow account." `[🔐 Log in to Inflow]` (Mini App).
2. On success: with exactly one saved plate, it becomes the default. Otherwise the `/settings`
   plate screen (below) asks the user to pick a default, or to add a plate first.
3. "Any passes or carpool?" toggles: `[Alta access key…] [Brighton carpool ☐] [Solitude carpool ☐]` `[Done]`.
4. "All set. Tap /watch to start."

**`/watch`**:
1. `[Alta] [Brighton] [Solitude] [Solitude Nordic]`
2. Month calendar (inline keyboard, `‹ Jan 2027 ›`), days marked
   🟢 available · 🔴 full · 🟡 full-but-holds · 👀 already watching · ⚪ n/a.
   Tapping toggles selection (✅). `[✅ Watch 3 dates]` `[⚙️ Options]`
3. Options: mode `auto`/`notify`, carpool, and `🚘 Plate`. The plate picker offers the default
   plus the saved plates (no adding here). The chosen plate is stored on each new watch. To
   change a watch's plate later, delete the watch and watch the date again.
4. Confirmation: "Watching Alta: Sat Jan 16, Sun Jan 17, Sat Jan 23 · auto-book."
   If a picked date is 🟢 right now: "Jan 23 has spots now — [⚡ Book now]".

**`/watches`** — grouped by date:
`Sat Jan 16 · Alta · auto · polling 60s` `[⏸] [⚙️] [🗑]`; paused rows show reason + `[▶️ Resume]`.

**`/bookings`** — from `/current-reservations` per lot:
`Sat Jan 16 · Alta · ABC123 · #CONF123` / `plate changeable until 1:00pm` (or `plate locked`)
`[🚘 Plate · Jan 16] [❌ Cancel · Jan 16]`. Cancel has a confirm step.
- **🚘 Plate** shows while Inflow allows a change: before `allowPlateChangeUntil` (the end of the
  reservation window, later than the 8am cancel cutoff), or any time while the reservation has no plate yet.
- It opens a picker of saved plates, then a confirm step ("ABC123 → XYZ789?").
- The bot then calls `/plate-update` with the latest receipt, and re-renders the list with the
  result or Inflow's reason in plain words.

**`/settings`** — default plate, access keys, carpool toggles, `[🚘 Plates]`, `[🔐 Re-login]`, `[🚪 Logout & wipe]`.

**`/settings` → 🚘 Plates** shows the Inflow account's saved plates, one per row:
`[⭐ ABC123 · default] [🗑]`, `[XYZ789] [🗑]`, then `[➕ Add plate] [↩︎ Back]`.
- **Tap a plate** to make it the default.
- **➕ Add plate** asks for the plate as a chat message. The bot uppercases it, keeps letters and digits only,
  and accepts 2–12 characters (the Inflow app's rule). It then asks "Add XYZ789 to your Inflow account?"
  `[Add] [Cancel]`. If no plate arrives within 10 minutes, the request lapses and later text is ignored.
- **🗑** asks for confirmation, then removes the plate.
- **How saving works:** Inflow only accepts the whole user record (`PUT /appuser`). The bot re-reads
  `/account` and sends it back unchanged apart from `savedPlates`. If Inflow rejects that, the bot shows
  the error and keeps nothing.
- **Default plate:** the first plate added becomes the default if none is set. Removing the default plate
  clears it, so watches that rely on the default pause with "no plate" until one is picked.
(Quiet hours: deferred. Non-urgent messages are already sent silently.)

**`/status`** — Inflow login health, scout health, active watches + next poll time.

**`/admin`** — `[➕ Invite]` (one-time code), users list (disable), release windows
(list/toggle/add), scout status/re-login, `[🛑 Kill switch]`.

**Push alerts:**
- `🎉 Booked Alta · Sat Jan 16 · $25 · ABC123` `[🚘 Change plate] [❌ Cancel]`
- `⏳ Holding Alta Sat Jan 16 — pay within 4:00` `[💳 Pay now]`
- `👀 Spot open: Brighton Sat Jan 16` `[⚡ Book now]` (notify mode)
- `⏸ Paused Alta Jan 16: account at max 4 reservations` `[▶️ Resume]`
- `🔐 Inflow login expired` `[Log in]`

Admin-only alerts: scout auth failure, Inflow error-rate spike, response-schema parse
failure, unhandled exceptions.

## 7. Observability

Workers Logs (structured JSON, `event` field). `events` table for user-visible history.
Admin Telegram alerts (§6), de-duplicated (same alert ≤ 1 / 30 min).

## 8. Testing

- Unit: SRP math (cross-checked against `amazon-cognito-identity-js`), rate selection,
  cadence calculation, error classification, Mini App `initData` verification.
- Integration (vitest-pool-workers / Miniflare): DOs + D1 against a **fake Inflow** fetch
  handler that scripts availability changes and booking responses.
- Never call live Inflow in tests.

## 9. Spike (gate before building) — ✅ PASSED 2026-11-07

All gates passed. See [`research/spike-results.md`](research/spike-results.md): `USER_PASSWORD_AUTH`,
24 h ID tokens, 10-minute holds, and headless Stripe confirm with the saved card (no 3DS).

Code: `src/inflow/` (Worker-compatible, WebCrypto only — becomes production code) +
`spike/cli.ts` (Node runner). See `spike/README.md`.

Questions to answer on a real account:
1. **Auth** — does `USER_PASSWORD_AUTH` work, or is SRP required? Does Cognito advanced
   security block non-browser sign-in? Token lifetimes (ID / refresh)?
2. **Read path** — `/calendars`, `/calendar-availability`, `/calendar-rates` with a
   Cognito ID token; is the calendar-ID-on-session assumption right?
3. **Hold** — `/select-rate` hold duration (`holdReleaseTimestamp − now`).
4. **Pay** — can a saved card be used headlessly via Stripe (`elements/sessions` to list
   saved PMs, `payment_intents/{id}/confirm` with publishable key + client secret)?
   Does it hit 3DS? Does Inflow's webhook then mark it paid (`/confirm-payment`)?
5. **Cancel** — `/cancel-reservation` refunds before cutoff.

Pass criteria: (1)+(2)+(3) work headlessly. (4) either works, or fails cleanly into the
handoff path. Record results in `docs/research/spike-results.md`.

## 10. Deployment (2026-11-07)

- Worker: `https://parking-reservation-bot.huang-inc.workers.dev` (account "Huang Labs"); bot `@parking_reservation_heem_bot`.
- D1 `parking-reservation-bot` (WNAM). Cron `*/5 * * * *` re-arms monitors, expires watches, unsticks `booking`
  rows older than 15 minutes, and purges old rows at 03:00.
- Scout degradation self-heals: while degraded it lets one probe through every 5 minutes.
