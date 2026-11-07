# Inflow parking reservation platform (Alta / Brighton / Solitude): research notes

Researched 2026-11-07. Method: public web pages, the public SPA bundle at `reserve.inflowparking.com`
(including its **publicly served source maps**), and a few anonymous API calls the SPA makes on
page load (`/welcome`, `/session-status`). No account was created and no login was attempted.

Legend: **[V]** = verified directly (HTTP response / source code); **[S]** = stated on an official
resort page; **[I]** = inferred, not verified.

---

## 1. Booking URLs and vendor

All three resorts' reservation flows run on the same platform: **Inflow** (Inflow, Inc.), white-labelled as
"Reserve 'N Ski". The lots are operated by **Interstate Parking, LLC**, which is enterprise `IPCCO` in Inflow.
The informational sites (`altaparking.com`, `parkbrightonresort.com`, `parksolitude.com`) are Wix sites
behind Cloudflare. They only link out to the Inflow app. **[V]**

| Resort | Info site | Booking entry URL (qrLookupID) | Inflow IDs (from `/welcome` JWT) |
|---|---|---|---|
| Alta | https://www.altaparking.com | https://reserve.inflowparking.com/qr/altaparking/welcome (`reserve.altaparking.com` → `pk.zone/altaparking` → `reserve.inflowparking.com/welcome?qr=altaparking`) | enterprise `IPCCO`, market `IPCCO-Mf2g7x`, location `IPCCO-Mf2g7x-Lnttiz` |
| Brighton | https://www.parkbrightonresort.com | https://reserve.inflowparking.com/qr/ParkBrightonResort/welcome | market `IPCCO-Mfjtrb`, location `IPCCO-Mfjtrb-L2uiuz` |
| Solitude (Moonbeam) | https://www.parksolitude.com | https://reserve.inflowparking.com/qr/ParkSolitude/welcome | market `IPCCO-Mp8g53`, location `IPCCO-Mp8g53-Ll4hxx` |
| Solitude Nordic | (same) | https://reserve.inflowparking.com/qr/ParkSolitudeNordic/welcome | same location as Moonbeam. The Nordic lot is probably a separate booking calendar **[I]** |

Not Inflow:
- **Alta early-morning (pre-8am) parking**: `altaearlyparking.com` links to **Honk** at
  `https://parking.honkmobile.com/hourly/zones/5401`. **[V]**
- Alta's main reservations ran on **Honk** in earlier seasons. That is why the only existing bot (see §6) targets Honk. For 2026-27 the main Alta flow is on Inflow. **[V]**
- `www.inflowparking.com` redirects to `www.inflowsystems.com`, the Webflow marketing site. **[V]**

## 2. Auth and bot protection

**Account auth: AWS Cognito via Amplify JS v6** **[V]**
- Configured in the bundle as follows:
  `Amplify.configure({Auth:{Cognito:{userPoolClientId:"2rgie6ca69hfcjh76hjrkjclei",userPoolId:"us-east-2_OAjdb1vtY"}}})`
- The browser calls `cognito-idp.us-east-2.amazonaws.com` directly, as allowed by the CSP `connect-src`.
- Sign-in is **email + password** (`api.auth.signIn({username: email, password})` in
  `src/routes/auth/sign-in/index.tsx`). No `authFlowType` is passed, so Amplify uses its default, **USER_SRP_AUTH**. The
  bundle also contains Amplify's USER_PASSWORD_AUTH code, but that is library code. Whether this app client allows
  USER_PASSWORD_AUTH is **unverified** (checking would need an InitiateAuth call). [I]
- Sign-up collects email, phone (E.164), given and family name, and requires an email verification code (`confirmSignUp`).
- If the sign-in result is anything other than DONE or CONFIRM_SIGN_UP, the UI shows "additional auth step" as an error. In practice this
  means no MFA or OTP is expected in the normal flow. [V code / I config]
- There is no hosted UI or OAuth social login in the SPA. The pool's OIDC discovery is public at
  https://cognito-idp.us-east-2.amazonaws.com/us-east-2_OAjdb1vtY/.well-known/openid-configuration (RS256).
- Tokens: Amplify keeps ID, access and refresh tokens in **localStorage** and refreshes them automatically. Cognito defaults
  are ID/access token 1h and refresh token 30d, but this pool's actual lifetimes are **unverified** [I].
- How the Cognito token reaches the Inflow API: the **Cognito ID token (JWT) goes in the JSON body** as
  `cognitoIDToken`, not in a header. When it has expired the backend returns `failReason: "CognitoTokenExpired"`.

**Inflow session token** (separate from the Cognito login) **[V]**
- `POST https://reserve.prod.inflowservice.com/welcome {"qr":"altaparking"}` returns `{"sessionToken":"<JWT>"}`. No auth is needed.
- The token is HS256 and its payload is `{reserveSessionID, issuedAt, enterpriseID, marketID, locationID, iat, exp, iss:"Inflow"}`.
  **Its lifetime is 90 days** (exp − iat = 7,776,000 s).
- Every later call sends `Authorization: Bearer <sessionToken>`. Without it, API Gateway returns `401 {"message":"Unauthorized"}`.
- The token is **server-side cart state**: the selected calendar, date, rate, plate and hold live on the `reserveSessionID`. The SPA keeps it in sessionStorage
  under the key `welcomeToken`, together with an `epoch` that it puts into its own URLs (`/qr/$qr/reserve/$epoch/...`).

**Captcha:** I found none. The main bundle and all 515 lazy chunks contain no reference to recaptcha, hcaptcha, turnstile or
captcha, and the CSP allows no captcha origins. **[V]**

**Bot protection**
- The API runs on AWS API Gateway behind CloudFront: responses carry `x-amz-apigw-id` and `x-amz-cf-pop`. I saw no Cloudflare, Akamai,
  DataDome or PerimeterX headers or cookies on `*.inflowservice.com` or `reserve.inflowparking.com`. **[V]**
- CORS returns `Access-Control-Allow-Origin: *`. **[V]**
- AWS WAF or API Gateway throttling may exist but cannot be seen from outside. **[I]**
- The Wix info sites use Cloudflare (`__cf_bm`), but a bot never needs them.
- Sentry logging is extensive: every request and response body is sent as a breadcrumb.

## 3. API

Style: **REST-ish JSON, every call is a `POST`**. Errors return HTTP 200 or 4xx with a body of the form `{"failReason": "<Enum>"}`.
There is no GraphQL; the only "graphql" strings in the bundle are Amplify library code. **[V]**

Base URLs (`BASE_API_URL` in the bundle) **[V]**:
- `reserve`: `https://reserve.prod.inflowservice.com`. The SPA selects this mode when the hostname is `reserve.inflowparking.com` or `reservenski.inflowparking.com`.
- `gated`: `https://gated.prod.inflowservice.com`. This is the default mode and serves `/theme`, `/account`, `/saved-payment-methods` and others.
- `park`: `https://park.prod.inflowservice.com`.
- There are also `dev` and `staging` variants of each.

Mapping of endpoints with no `apiMode` [I, needs check in a real session]: these calls default to the **gated** API (`/account`, `/theme`,
`/saved-payment-methods`, `/setup-intent-wallet`). `POST reserve.../theme` returned an API Gateway IAM-style 403, which fits that mapping.

Headers the SPA sends: `Accept: application/json`, `Content-Type: application/json`, `Authorization: Bearer <welcome sessionToken>`.

### Reserve endpoints (from `src/utilities/api.ts` and `src/utilities/hooks/queries/reserve.ts`, via source maps) **[V]**

| Endpoint | Body | Notes |
|---|---|---|
| `POST /welcome` | `{qr}` | Returns `{sessionToken}`. Anonymous. |
| `POST /session-status` | `{}` | Returns `{status: InProgress\|Complete, inventoryTreeRate, plate, receiptID, holdReleaseTimestamp, selectedDateOnly, selectedEndDateOnly, bookingCalendarID, transactionDetails}`. Works anonymously (verified). |
| `POST /calendars` | `{cognitoIDToken}` | Returns `{calendars: BookingCalendarMini[]}` with `bookingCalendarID` and `metadata.header` / `metadata.description`. Fails with `400 InvalidRequestFormat` if the token is empty or missing (verified). |
| `POST /calendar-availability` | `{bookingCalendarID, cognitoIDToken, month:"YYYY-MM"}` | Returns `{calendarMode: Single\|Range, availability: {"YYYY-MM-DD": {availabilityStatus}}}`. |
| `POST /calendar-rates` | `{cognitoIDToken, dateOnly:"YYYY-MM-DD", endDate?}` | Returns `{rates: {id: InventoryTreeRateMini}}`. Fail reasons include `MaxConcurrentReservationsReached`, `MaxTotalReservationsReachedForDay`, `...ForMonth`, `...UntilDateWithReset`, `BookingCalendarIDMismatch` and `Forbidden`. The body has no calendar ID, so the server must take it from session state, probably set by `/calendar-availability` [I]. |
| `POST /select-rate` | `{cognitoIDToken, inventoryTreeRateMiniID}` | **Creates the hold.** Fails with `ReservationCapacityReached` when sold out. |
| `POST /plate` | `{plate: string\|null, plateEntrySkipped: bool}` | Fail reasons: `InvalidPlate`, `MaxConcurrentReservationsReached`. Saved plates come from `inflowUser.savedPlates` (gated `/account`). |
| `POST /checkout` | `{}` | Returns the transaction: `transactionDetails{paymentFlow, amountDue, expectedAmountDue, reservationNoShowFeeConfig, reservationDepositConfig}` and `cancellationDeadline`. |
| `POST /promo-payment` | `{cognitoIDToken, promoCode}` | Applies a promo or discount code. |
| `POST /apply-code` | `{cognitoIDToken, ...}` | Applies an access key or membership code, such as passholder codes that unlock free inventory. |
| `POST /memberships` | | Lists the user's memberships. |
| `POST /payment-intent` | `{cognitoIDToken, phone, email, contactType: Phone\|Email}` | Returns `{requiresPayment, clientSecret, customerSessionClientSecret}`. Free rate: `requiresPayment:false` and `clientSecret:null`. |
| `POST /confirm-payment` | `{}` | Returns `{receiptID}`. The SPA polls it up to 8 times at 1s intervals while the reply is `PaymentWebhookNotCompleted`. |
| `POST /setup-intent` | same as payment-intent | Used when `paymentFlow === SetupIntent`, that is a $0 reservation with a card held for a no-show fee. |
| `POST /confirm-setup-intent` | `{}` | Returns `{receiptID}`. Fail reason: `WebhookNotCompleted`. |
| `POST /receipt` | `{receiptID}` | Returns the confirmation details. |
| `POST /current-reservations` | `{cognitoIDToken, locationID\|null}` | Returns `{reservations: ReservationMini[]}`. |
| `POST /past-reservations` | same | |
| `POST /cancel-reservation` | `{cognitoIDToken, reservationID, locationID, enterpriseID}` | Fail reason: `CancellationBlocked`. |
| `POST /plate-update` | | Fail reasons: `WindowClosed`, `ReservationExistsForPlate`, `ReservationNotActive`. |

Shared or gated endpoints: `/account` (`{cognitoIDToken}` returns the inflowUser, including savedPlates), `/appuser` (PUT), `/saved-payment-methods`,
`/saved-payment-method-actions` (ADD / DELETE / MAKE_DEFAULT), `/setup-intent-wallet`, `/confirm-setup-intent-wallet`,
`/auto-pay-select-card`, `/email`, `/text`, `/receipt`.

### Key data shapes (from source and enums) **[V]**
- `ReservationDateAvailabilityStatus`: `Available | Full | FullButNotAllConfirmed | NotRequired | NoInventoryActive | ComingSoon | Closed`.
  `FullButNotAllConfirmed` means the date is full only because some spots are held but not yet paid. **Those holds can expire and release
  the spot**, which makes it a good polling trigger.
- `InventoryTreeRateMini`: `{inventoryTreeRateMiniID, rateStatus: Available|SoldOut|PrivilegeExhausted|Ended, rateName,
  originalPrice, finalPrice, startDateTime, endDateTime, rateProductID, inventoryTreeRateID, inventoryPoolID, inventoryTreeID,
  inventoryTreeRateAndCapacityID, bookingCalendarID, warningMessage, membershipInfo, inventoryAccessPromotionID,
  inventoryAccessPromoCode, membershipAccessCode, cancellationDeadline, discountDisplayMode, expectedAmountDue,
  autoApplyPromotions[]...}`. The response has no remaining-count field; it only gives a status.
- `ReservationMini`: `reservationID, status (Active|CancelledBySelf|CancelledByAdmin|Expired), startDateTime, endDateTime,
  plate, cancellationDeadline, blockCancellation, allowPlateChangeUntil, bookingCalendarName, inventoryTreeRateName,
  confirmationNumber, receiptIDs, locationID, enterpriseID, locationTimezone`.
- `ReservationHoldStatus`: `Held | Confirmed | Expired | Released`. `ReleasePhaseType`: `Always | SpecificDate | DaysBefore | Weekday`.
- `BookingCalendarLimitPerPlate`: `OnePerDay | Unrestricted`. `RateRestrictionType`: `PerPlate | PerAccount | NumberOfSales`.

### Hold and cart behaviour **[V]**
- `/select-rate` creates a hold, and `holdReleaseTimestamp` in `/session-status` is its deadline. The UI starts warning 120s before
  expiry. **The hold length is not in the client** and is probably a few minutes [I].
- Only one purchase session is allowed at a time. If another session already holds a cart, the server returns the sentinel
  `holdReleaseTimestamp = "2000-01-01T00:00:00.000Z"` and the UI shows a "Reservation In Progress" page. This is very likely enforced
  per account [I]. **A bot and a human must not check out at the same time on the same account.**
- Checkout fail reasons include `ReservationHoldExpired`, `ReservationWindowEnded`, `PaymentAlreadyCompleted` and `MissingPlate`.

### Payments **[V]**
- The payment processor is **Stripe** (live publishable key `pk_live_51LYXdnCi5L1n7FuO...` in the bundle). Checkout uses the **Payment
  Element**, calling `stripe.confirmPayment({elements, redirect:"if_required"})` or `stripe.confirmSetup(...)`. The
  `customerSessionClientSecret` is a Stripe Customer Session, which shows the user's saved cards inside the Payment Element.
- Paid flow, in order:
  1. `/payment-intent`
  2. Stripe confirm in the browser
  3. Inflow learns of the payment through a Stripe webhook
  4. `/confirm-payment` (polled) returns `receiptID`
- **The reserve flow has no server-side "pay with saved card" endpoint.** Payment always goes through a client-side Stripe confirm.
  (The gated product has `/auto-pay-select-card`, but that is the gated-garage product.)
- Replicating payment headlessly would mean calling Stripe's `POST /v1/payment_intents/{id}/confirm` with the publishable key, the
  client_secret and a saved `payment_method`. That is technically plausible, but 3DS/SCA challenges (`requires_action`), Radar,
  and Stripe ToS make it fragile. A $0 rate (passholder code or carpool) avoids Stripe entirely, unless the calendar is set up with a no-show card hold, which makes it a SetupIntent. [I]
- The checkout copy confirms that free carpool spots can still require a card: *"Free spots are limited, so a card will be held to keep
  no-shows from taking spaces others could use."*

## 4. Unauthenticated availability

**Not possible through the documented flow.** **[V]**
- `/welcome` and `/session-status` work anonymously.
- `/calendars` rejects an empty or missing `cognitoIDToken` with `400 InvalidRequestFormat`, and a garbage token with `500 SystemError`.
- `/calendar-availability` and `/calendar-rates` take the same `cognitoIDToken` field.
- The SPA's reserve route guard also redirects unauthenticated users to /welcome.

So the monitor needs a valid Cognito ID token, meaning a real account with a refresh-token loop. One welcome session token
lasts 90 days.

## 5. Booking rules (2026-27, per official pages) **[S]**

**Alta** (https://www.altaparking.com/faq, https://www.altaparking.com/parkingbasics)
- Required Friday–Sunday and holidays, 8am–1pm, from Dec 11, 2026, to early April, plus Closing Day.
- Prices:
  - $25/day general.
  - Ikon and Mountain Collective holders pay $25.
  - Online lift-ticket buyers get a discount access key ($10 rate, or "$15 discount").
  - Qualifying Alta and Alta-Bird passholders get **free** reservations via an access key. The key is reusable once the date passes and depends on availability.
- **Max 4 active reservations per account** (free and paid). Same-day reservations do not count toward the limit.
- Releases: *"additional parking is released each Sunday at 3pm (MST) for the following weekend or holiday period"*. *"cancellations open parking spots daily."*
- Cancel by 8am on the reservation day for a refund. The first no-show is a warning, then $100 per no-show. Parking without a reservation costs $150–$250 (the pages disagree).
- A plate is required and must be correct by 8am (or by the reservation start). "RENTAL" is allowed as a placeholder.
- Alta lists **no free 4+ carpool rate** (carpooling is only suggested).

**Brighton** (https://www.parkbrightonresort.com/faq)
- Required before 12pm Friday–Sunday and holidays.
- Prices:
  - General (1–3 people): $25 Friday–Sunday and holidays.
  - **Carpool (4+): $10**, verified on arrival. Oversized vehicles are excluded.
  - Free Monday–Thursday and after 12pm.
  - Preferred: $30.
  - Passholders: free via a reusable voucher, **max 2 free reservations at a time**.
- Up to 2 plates per profile, and **max 5 reservations per plate at one time**. The FAQ even suggests appending "UT" to a plate to exceed this.
- Releases:
  - Pre-season block on Aug 10, 2026, 10am.
  - **The upcoming weekend opens Mondays at 6pm.**
  - **Remaining inventory opens the day before arrival at 8am and 2pm.**
- Fully refundable if cancelled before 8am on the day. Plate changes are also allowed until 8am.

**Solitude** (https://www.parksolitude.com/parkingbasics)
- Season Dec 18, 2026 – Mar 28, 2027.
- Moonbeam: Friday–Sunday and holidays, 7–11am, **$35**.
- Nordic: Saturday–Sunday and holidays, 7–11am, $15.
- Free after 11am.
- **Carpool 4+ is free but still needs a reservation**, with occupancy verified at the entry. If fewer people show up, you pay the standard fare onsite.
- **Max 3 reservations at Moonbeam + 3 at Nordic at one time.**
- Releases:
  - Bookings opened Oct 15, 2026, at 6pm.
  - **More inventory every Sunday at 6pm for the following weekend.**
  - **Some spaces on the day itself at 6am** from cancellations.
- Cancel before 8am on the day without penalty (the page also says 6am). After that a no-show fee applies (amount not listed).
- A card is required, but 4+ reservations are not charged up front.

**Platform-side limits** that exist in the code (they are configured per calendar, so actual values are unknown): `OnePerDay` per plate,
per-day, per-month and rolling caps, and `MaxConcurrentReservationsReached`. **[V enums / I config]**

## 6. Existing open-source bots

- **vsicle/alta-parking-bot** (https://github.com/vsicle/alta-parking-bot, created 2026-03-16, 1 star). It drives
  real Chrome with Playwright against **Honk** (Alta's old vendor) at an 8:00 AM MST open, claiming this avoids Cloudflare anti-bot
  detection. **It does not apply to the Inflow platform.** Its main lesson: inventory at release time sells out in seconds.
- GitHub repo and code searches for `inflowservice`, `inflowparking`, `reserve.inflowparking`, `altaparking` and related terms found **nothing**. [V, as of 2026-11-07]

## 7. Terms of service

The resort sites link to the Interstate Parking terms at https://www.interstateparking.com/terms-of-use (effective April 6, 2026).
Those terms cover "Interstate Parking, LLC ... and Inflow, Inc." (together "the Companies") and their websites, services and Application. **[S]**
The terms say you must not:
- *"Use any robot, spider, or other automatic device, process, or means to access the Website for any purpose"*
- *"Use any manual process to monitor or copy any of the material on the Website"*
- *"Use any device, software, or routine that interferes with the proper working of the Website"*, or *"overburden"* it

They also say:
- *"permit You to use the Website for Your personal, non-commercial use only"*
- Breach automatically terminates your permission. They *"have the right to disable any user name, password..."*

**Implication: an auto-booking bot clearly violates the ToS. Account suspension, and loss of passholder parking benefits, is a real risk.**

## Architectural takeaways for a Cloudflare Workers bot

1. **One vendor, one API.** Each resort is just a different `qr` value (altaparking / ParkBrightonResort / ParkSolitude / ParkSolitudeNordic).
2. **Plain `fetch` works.** I saw no captcha, no JS challenge and no browser fingerprinting on the API, and CORS is `*`. Workers can call it directly. (AWS WAF rate limiting may exist [I].)
3. **Auth in a Worker:**
   - Do Cognito SRP (or USER_PASSWORD_AUTH, if enabled) once.
   - Store the refresh token (KV or Durable Object, encrypted) and refresh with `InitiateAuth REFRESH_TOKEN_AUTH` to get a fresh ID token.
   - Send the ID token as `cognitoIDToken` in the body, and the 90-day welcome JWT as `Authorization: Bearer`.
   - Cognito sign-in from a bot may itself trip Cognito advanced security [I].
4. **Polling:** `/calendar-availability` (month-level status), then `/calendar-rates` (rate status per date). `FullButNotAllConfirmed` means a spot may free up when someone's hold expires. Concentrate polling around the release times:
   - Alta: Sunday 3pm.
   - Brighton: Monday 6pm, and the day before at 8am and 2pm.
   - Solitude: Sunday 6pm, and the day itself at 6am.
   - All three: the 8am-day-of cancellation deadline, and hold expiries.
5. **Booking:**
   - The sequence is `/select-rate` (hold), `/plate`, `/checkout`, then either `/payment-intent` or `/setup-intent`.
   - For **$0 rates** (passholder access key, Solitude 4+ carpool) with `requiresPayment:false`, go straight to `/confirm-payment`. This path is fully headless.
   - For paid or card-hold rates, Stripe client-side confirmation is required. Plan for headless Stripe confirm with a saved PM (3DS risk), or notify the human to finish in the browser before the hold expires.
6. **State:** the Inflow cart is server-side per welcome session, and there is one concurrent purchase session per account. Use one Durable Object per account to serialize booking attempts.
7. **Account limits cap the bot** (Alta 4 active, Brighton 5 per plate and 2 free, Solitude 3 per lot). Read `/current-reservations` before booking.
8. **ToS risk:** automated access is explicitly prohibited (see §7).

## Sources
- https://www.altaparking.com, https://www.altaparking.com/faq, https://www.altaparking.com/parkingbasics
- https://www.parkbrightonresort.com, https://www.parkbrightonresort.com/faq
- https://www.parksolitude.com, https://www.parksolitude.com/parkingbasics
- https://www.altaearlyparking.com (links to Honk zone 5401)
- https://reserve.inflowparking.com/assets/index-BymY69yA.js and `.js.map`, publicly served. They include `src/utilities/api.ts`,
  `src/utilities/reserveHold.ts`, `src/utilities/hooks/queries/reserve.ts`, and the `src/routes/qr/$qrLookupID/reserve.$epoch/**` routes. These bundle hashes will change on redeploy.
- https://reserve.prod.inflowservice.com/welcome and /session-status (observed anonymously)
- https://cognito-idp.us-east-2.amazonaws.com/us-east-2_OAjdb1vtY/.well-known/openid-configuration
- https://www.interstateparking.com/terms-of-use
- https://github.com/vsicle/alta-parking-bot
- News background: https://www.ksl.com/article/50784323/brighton-solitude-moving-to-paid-parking-reservation-system-this-season,
  https://www.kpcw.org/ski-resorts/2023-11-16/brighton-launches-parking-reservation-system
