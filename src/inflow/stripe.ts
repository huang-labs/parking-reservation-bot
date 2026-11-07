/**
 * Headless Stripe confirmation with a customer's saved card, using only what the Inflow SPA
 * itself has: the publishable key, the PaymentIntent client secret, and the Customer Session
 * client secret. UNVERIFIED — this is what the spike tests (docs/DESIGN.md §9, Q4).
 */

type Fetch = typeof fetch;
const STRIPE = "https://api.stripe.com/v1";

/** Scrape the live publishable key from the Inflow SPA bundle (it rotates with deploys). */
export async function findPublishableKey(f: Fetch = fetch): Promise<string> {
  const html = await (await f("https://reserve.inflowparking.com/")).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]!);
  for (const src of scripts) {
    const js = await (await f(new URL(src, "https://reserve.inflowparking.com/").toString())).text();
    const m = js.match(/pk_live_[A-Za-z0-9]{20,}/);
    if (m) return m[0];
  }
  throw new Error("Stripe publishable key not found in SPA bundle");
}

function intentId(clientSecret: string): string {
  return clientSecret.split("_secret_")[0]!;
}

async function stripe<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  f: Fetch = fetch,
): Promise<{ status: number; body: T }> {
  const qs = new URLSearchParams(params).toString();
  const res = await f(method === "GET" ? `${STRIPE}${path}?${qs}` : `${STRIPE}${path}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
    body: method === "POST" ? qs : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

export interface SavedCard {
  id: string;
  brand?: string;
  last4?: string;
}

/** List saved cards via the same Elements session call the Payment Element makes. */
export async function listSavedCards(args: {
  publishableKey: string;
  clientSecret: string;
  customerSessionClientSecret: string;
  setup?: boolean;
  fetch?: Fetch;
}): Promise<{ cards: SavedCard[]; raw: unknown }> {
  const { status, body } = await stripe<Record<string, any>>(
    "GET",
    "/elements/sessions",
    {
      key: args.publishableKey,
      type: args.setup ? "setup_intent" : "payment_intent",
      client_secret: args.clientSecret,
      customer_session_client_secret: args.customerSessionClientSecret,
      locale: "en",
    },
    args.fetch,
  );
  const pms: any[] = body?.customer?.payment_methods ?? [];
  const cards = pms.map((p) => ({ id: p.id, brand: p.card?.brand, last4: p.card?.last4 }));
  return { cards, raw: { status, keys: Object.keys(body ?? {}), customerKeys: Object.keys(body?.customer ?? {}), error: body?.error } };
}

export type ConfirmOutcome =
  | { kind: "succeeded"; raw: unknown }
  | { kind: "requires_action"; nextAction: unknown; raw: unknown }
  | { kind: "failed"; error: unknown; raw: unknown };

export async function confirmWithSavedCard(args: {
  publishableKey: string;
  clientSecret: string;
  paymentMethodId: string;
  setup?: boolean;
  fetch?: Fetch;
}): Promise<ConfirmOutcome> {
  const kind = args.setup ? "setup_intents" : "payment_intents";
  const { body } = await stripe<Record<string, any>>(
    "POST",
    `/${kind}/${intentId(args.clientSecret)}/confirm`,
    {
      key: args.publishableKey,
      client_secret: args.clientSecret,
      payment_method: args.paymentMethodId,
      return_url: "https://reserve.inflowparking.com/",
      use_stripe_sdk: "true",
    },
    args.fetch,
  );
  if (body.error) return { kind: "failed", error: body.error, raw: body };
  if (body.status === "succeeded" || body.status === "processing") return { kind: "succeeded", raw: body };
  if (body.status === "requires_action") return { kind: "requires_action", nextAction: body.next_action, raw: body };
  return { kind: "failed", error: { status: body.status }, raw: body };
}
