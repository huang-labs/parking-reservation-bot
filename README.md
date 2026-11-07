<img src="assets/icon.svg" width="64" height="64" alt="">

# parking-reservation-bot

A Telegram bot that books freed-up parking at **Alta, Brighton, and Solitude** (all on Inflow)
the moment someone cancels. It runs on Cloudflare Workers, D1, and Durable Objects.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Inflow API research: [docs/research/inflow-api.md](docs/research/inflow-api.md)
- Spike results: [docs/research/spike-results.md](docs/research/spike-results.md)

## Using it

1. The admin taps **/admin → ➕ Invite** and sends a friend the one-time `t.me/...?start=<code>` link.
2. The friend taps **🔐 Log in to Inflow** (a Mini App, so the password never appears in chat) and picks a default plate.
3. Optional: in **/settings**, the friend adds a passholder access key per lot and toggles 4+ carpool.
4. The friend runs **/watch**, picks a lot, taps the sold-out dates (🔴/🟡), and taps ✅. The bot books automatically
   when a spot opens. If the bank asks for 3-D Secure, the friend gets a **💳 Pay now** button and has the rest of the 10-minute hold to pay.

Other commands: `/watches` (pause, resume, mode, delete), `/bookings` (list and cancel), `/status`, `/help`.
Admin only: `/admin` (invites, users, release windows, scout re-login, 🛑 kill switch) and `/addwindow`.

## Develop

```sh
npm install
npm test            # node + Workers-runtime tests (Miniflare); never touches live Inflow
npm run typecheck
```

The spike CLI (`spike/`) exercises the live Inflow API against your own account. See `spike/README.md`.

## Deploy

Wrangler can reuse the `cf` CLI login:

```sh
export CLOUDFLARE_API_TOKEN="$(node -p 'require(process.env.HOME+"/.config/cloudflare/config/default.json").oauth_token')"
npx wrangler d1 migrations apply parking-reservation-bot --remote   # when migrations/ changes
npx wrangler deploy
```

Secrets are set with `wrangler secret put`:

| Secret | What it holds |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string; also passed to `setWebhook` as `secret_token` |
| `CREDS_ENC_KEY` | `openssl rand -base64 32`. AES-GCM key for stored Inflow passwords. If it is rotated, users must log in again. |
| `SCOUT_EMAIL` / `SCOUT_PASSWORD` | Throwaway Inflow account used for availability polling |
| `ADMIN_TG_USER_ID` | Admin's numeric Telegram user id |

Webhook: `setWebhook` with `url=<PUBLIC_URL>/telegram`, `secret_token=<TELEGRAM_WEBHOOK_SECRET>`, and
`allowed_updates=["message","callback_query"]`.

Logs: `npx wrangler tail`, or Workers Logs in the dashboard. Each log line is JSON with an `event` field.
