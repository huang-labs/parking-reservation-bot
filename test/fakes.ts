/** Scriptable fake for Cognito, Inflow, Stripe and Telegram, installed as global fetch. */

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
export const fakeJwt = (claims: Record<string, unknown>) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`;

export interface Scenario {
  availability: string; // status for every date
  rates: { id: string; name: string; price: number; status?: string }[];
  selectFail?: string; // failReason for /select-rate
  paymentFlow?: "PaymentIntent" | "SetupIntent" | "Free";
  stripeStatus?: "succeeded" | "requires_action";
  cognitoFail?: boolean;
  holdSentinel?: boolean;
}

export interface Recorder {
  calls: { url: string; path: string; body: any }[];
  telegram: { method: string; body: any }[];
}

export function installFake(s: Scenario): Recorder {
  const rec: Recorder = { calls: [], telegram: [] };
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  const fail = (failReason: string) => ok({ failReason });
  const exp = Math.floor(Date.now() / 1000) + 86_400;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    rec.calls.push({ url: url.href, path: url.pathname, body });

    if (url.hostname === "api.telegram.org") {
      const method = url.pathname.split("/").pop()!;
      rec.telegram.push({ method, body });
      if (method === "getMe") {
        return ok({ ok: true, result: { id: 999, is_bot: true, first_name: "Bot", username: "testbot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } });
      }
      return ok({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
    }
    if (url.hostname.startsWith("cognito-idp")) {
      if (s.cognitoFail) return new Response(JSON.stringify({ __type: "NotAuthorizedException", message: "nope" }), { status: 400 });
      return ok({ AuthenticationResult: { IdToken: fakeJwt({ exp, iat: exp - 86400 }), AccessToken: "a", RefreshToken: "r", ExpiresIn: 86400 } });
    }
    if (url.hostname === "reserve.inflowparking.com") {
      if (url.pathname === "/") return new Response('<script type="module" src="/assets/index-x.js"></script>');
      return new Response('var k="pk_live_51FAKEFAKEFAKEFAKEFAKEFAKE";');
    }
    if (url.hostname === "api.stripe.com") {
      if (url.pathname.endsWith("/elements/sessions")) return ok({ customer: { payment_methods: [{ id: "pm_1", card: { brand: "visa", last4: "4242" } }] } });
      if (url.pathname.endsWith("/confirm")) {
        return ok(s.stripeStatus === "requires_action" ? { status: "requires_action", next_action: { type: "use_stripe_sdk" } } : { status: "succeeded" });
      }
    }
    if (url.hostname === "reserve.prod.inflowservice.com" || url.hostname === "gated.prod.inflowservice.com") {
      switch (url.pathname) {
        case "/welcome":
          return ok({ sessionToken: fakeJwt({ locationID: "LOC", enterpriseID: "IPCCO", exp }) });
        case "/apply-code":
          return ok({});
        case "/calendars":
          return ok({ calendars: [{ bookingCalendarID: "CAL1", metadata: { header: "Test" } }] });
        case "/calendar-availability": {
          const [y, m] = String(body.month).split("-").map(Number) as [number, number];
          const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const availability: Record<string, unknown> = {};
          for (let d = 1; d <= days; d++) {
            const date = `${body.month}-${String(d).padStart(2, "0")}`;
            availability[date] = { date, availabilityStatus: s.availability, rateTypesAvailable: [] };
          }
          return ok({ calendarMode: "Single", availability });
        }
        case "/calendar-rates":
          return ok({
            rates: Object.fromEntries(
              s.rates.map((r) => [r.id, { inventoryTreeRateMiniID: r.id, rateName: r.name, finalPrice: r.price, rateStatus: r.status ?? "Available" }]),
            ),
          });
        case "/select-rate":
          return s.selectFail ? fail(s.selectFail) : ok({});
        case "/session-status":
          return ok({
            status: "InProgress",
            holdReleaseTimestamp: s.holdSentinel ? "2000-01-01T00:00:00.000Z" : new Date(Date.now() + 600_000).toISOString(),
          });
        case "/plate":
          return ok({});
        case "/checkout": {
          const flow = s.paymentFlow ?? "PaymentIntent";
          return ok({ transactionDetails: { paymentFlow: flow === "Free" ? "PaymentIntent" : flow, amountDue: flow === "Free" ? 0 : s.rates[0]?.price ?? 0 } });
        }
        case "/payment-intent":
        case "/setup-intent":
          return s.paymentFlow === "Free"
            ? ok({ requiresPayment: false, clientSecret: null })
            : ok({ requiresPayment: true, clientSecret: "pi_123_secret_abc", customerSessionClientSecret: "cuss_1" });
        case "/confirm-payment":
        case "/confirm-setup-intent":
          return ok({ receiptID: "RCPT1" });
        case "/current-reservations":
          return ok({ reservations: [] });
        case "/account":
          return ok({ first: "Test", savedPlates: [{ plate: "ABC123", nickname: "Car" }] });
      }
    }
    return new Response(`unhandled ${url.href}`, { status: 599 });
  }) as typeof fetch;
  return rec;
}
