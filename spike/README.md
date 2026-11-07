# Spike: prove the Inflow unknowns

Answers docs/DESIGN.md §9. Results go in `docs/research/spike-results.md`.
Every API call is logged (token-redacted) to `spike/logs/*.jsonl`, which is gitignored.

```sh
npm install
cp .env.example .env          # fill INFLOW_EMAIL / INFLOW_PASSWORD (your own account)
```

Run in order. Steps 1–4 are read-only or only place a short hold. **Only step 6 charges your card.**

| # | Command | Answers |
|---|---|---|
| 1 | `npm run spike auth` | Which login flow works, ID-token lifetime, refresh works |
| 2 | `npm run spike availability alta 2026-12` | Calendars + month availability statuses |
| 3 | `npm run spike rates alta 2026-12-12` | Rates for a date (copy a rate `id`) |
| 4 | `npm run spike hold alta <rateId>` | **Hold duration** (a hold that's left alone just expires) |
| 5 | `npm run spike checkout alta <PLATE>` then `npm run spike intent alta` | paymentFlow, client secret, **saved cards visible headlessly?** (no charge) |
| 6 | `npx tsx spike/cli.ts pay <pm_id> --yes-charge` (npm swallows the flag) | **Headless Stripe confirm**: succeeded / requires_action (3DS) / failed |
| 7 | `npm run spike reservations alta` then `npm run spike cancel alta <reservationID>` | Cancellation + refund |

Use a cheap date well before the cancel cutoff, and cancel right after step 6. Steps 3–6 must run in the
same Inflow session; the CLI reuses it from `.spike-state.json`. To start fresh, run `npm run spike welcome alta`.

Other commands: `account` (gated `/account`, for saved plates), `raw <lot> <path> '<json>'`.
