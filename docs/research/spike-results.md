# Spike results (2026-11-07)

**Every gate passed.** The whole flow works headlessly with plain `fetch`: login → availability → hold →
checkout → pay with the saved card → confirm → cancel → refund. All runs used the owner's account:
Alta, Sat 2026-12-12, $25, booked and then cancelled. The refund settled.

| Question | Result |
|---|---|
| Login | ✅ **`USER_PASSWORD_AUTH` works**; SRP is not needed (kept as a fallback, and cross-tested against amazon-cognito-identity-js). Cognito advanced security did not block it. |
| Token lifetimes | **ID token 24 h** (`exp − iat = 86400`). Refresh token issued; `REFRESH_TOKEN_AUTH` works. The Inflow welcome session JWT lasts 90 days. |
| Calendars | ✅ One calendar per lot. Alta `…-Bovwdwtk6qcpv`, Brighton `…-Bpeqgzsyigks1`, Solitude `…-Becl3rac9r643`, Nordic `…-Bq1ozxwthidzg`. |
| `/calendar-availability` | ✅ `{calendarMode, availability: {date: {date, availabilityStatus, rateTypesAvailable: ["Public", …]}}}`. Each call took about 200–400 ms. |
| `/calendar-rates` | ✅ Works after `/calendar-availability` in the same session (that call sets the calendar on the session). Rate has `inventoryTreeRateMiniID`, `rateStatus`, `finalPrice`, `cancellationDeadline`. |
| `/select-rate` hold | ✅ **Hold = 600 s (10 min)**, read from `holdReleaseTimestamp` in `/session-status`. |
| `/plate` + `/checkout` | ✅ `paymentFlow: "PaymentIntent"`, `amountDue: 25`, `reservationNoShowFeeConfig: {amount: 100}`. |
| Gated `/account` | ✅ `gated.prod.inflowservice.com/account` with the same Bearer + `cognitoIDToken` → `{first, last, email, phone, savedPlates: [{plate, state, nickname, lastUsed}], stripeCustomerID, …}` |
| Saved cards headlessly | ✅ `/payment-intent` → `clientSecret` + `customerSessionClientSecret`. Stripe `GET /v1/elements/sessions` lists `customer.payment_methods` (`pm_…`, brand, last4). |
| **Headless Stripe confirm** | ✅ **`POST /v1/payment_intents/{id}/confirm`** with the publishable key, client secret and saved `payment_method` → `succeeded`, **no 3DS** (Visa). `/confirm-payment` returned `receiptID` on the first poll. |
| `/current-reservations` | ✅ Returns `reservationID`, status, start, plate, `confirmationNumber`, `cancellationDeadline`, `blockCancellation`, `locationID`, `enterpriseID`. |
| `/cancel-reservation` | ✅ `status: CancelledBySelf`, `cancellationReceiptID`. `/receipt` shows `receiptType: Refund`, `amountPaid: -25`, `status: Settled`. |

## Implications for the build
- Auth: password login plus refresh. Refresh the ID token at ~23 h; re-login with the stored password only if refresh fails.
- 3DS is still possible for other users' cards. Keep the Pay-now handoff, which the 10-minute hold makes comfortable.
- Booking takes about 6–8 sequential calls of ~0.3–2 s each (`/payment-intent` ≈ 2 s), so roughly 5–8 s from spotting a spot to holding and paying. Durable Objects handle that easily.
- `/calendar-rates` depends on session state, so each `AccountAgent` must call `/calendar-availability` before `/calendar-rates` in its own session.
- Passholder access codes, carpool rates and the `SetupIntent` flow were not exercised. Test them when a friend with a pass or carpool joins.
