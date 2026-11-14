/**
 * Thin Inflow "reserve" API client. Worker-compatible (fetch only).
 * Endpoint shapes come from docs/research/inflow-api.md (source maps of the SPA);
 * response types are deliberately loose until the spike confirms them.
 */

export const LOTS = {
  alta: { qr: "altaparking", name: "Alta" },
  brighton: { qr: "ParkBrightonResort", name: "Brighton" },
  solitude: { qr: "ParkSolitude", name: "Solitude" },
  "solitude-nordic": { qr: "ParkSolitudeNordic", name: "Solitude Nordic" },
} as const;
export type LotKey = keyof typeof LOTS;

export const RESERVE_API = "https://reserve.prod.inflowservice.com";
export const GATED_API = "https://gated.prod.inflowservice.com";

export type AvailabilityStatus =
  | "Available"
  | "Full"
  | "FullButNotAllConfirmed"
  | "NotRequired"
  | "NoInventoryActive"
  | "ComingSoon"
  | "Closed";

export interface RateMini {
  inventoryTreeRateMiniID: string;
  rateStatus: "Available" | "SoldOut" | "PrivilegeExhausted" | "Ended" | string;
  rateName: string;
  originalPrice?: number;
  finalPrice?: number;
  expectedAmountDue?: number;
  membershipInfo?: unknown;
  [k: string]: unknown;
}

export class InflowError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly failReason: string | undefined,
    public readonly body: unknown,
  ) {
    super(`${path} → ${status} ${failReason ?? JSON.stringify(body).slice(0, 200)}`);
  }
}

export interface CallLog {
  path: string;
  request: unknown;
  status: number;
  ms: number;
  response: unknown;
}

type Fetch = typeof fetch;

/** One Inflow reserve session (server-side cart) for one lot. */
export class InflowSession {
  constructor(
    public readonly lot: LotKey,
    public sessionToken: string,
    private getIdToken: () => Promise<string>,
    private opts: { fetch?: Fetch; onCall?: (log: CallLog) => void } = {},
  ) {}

  static async welcome(lot: LotKey, f: Fetch = fetch): Promise<string> {
    const res = await f(`${RESERVE_API}/welcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ qr: LOTS[lot].qr }),
    });
    const json = (await res.json()) as { sessionToken?: string };
    if (!res.ok || !json.sessionToken) throw new InflowError("/welcome", res.status, undefined, json);
    return json.sessionToken;
  }

  async call<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> = {},
    { auth = false, base = RESERVE_API, method = "POST" }: { auth?: boolean; base?: string; method?: "POST" | "PUT" } = {},
  ): Promise<T> {
    const payload = auth ? { cognitoIDToken: await this.getIdToken(), ...body } : body;
    const t0 = Date.now();
    const res = await (this.opts.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }
    this.opts.onCall?.({
      path,
      request: { ...payload, ...(auth ? { cognitoIDToken: "<redacted>" } : {}) },
      status: res.status,
      ms: Date.now() - t0,
      response: json,
    });
    const failReason = (json as { failReason?: string })?.failReason;
    if (!res.ok || failReason) throw new InflowError(path, res.status, failReason, json);
    return json as T;
  }

  sessionStatus() {
    return this.call<{
      status?: string;
      holdReleaseTimestamp?: string;
      selectedDateOnly?: string;
      bookingCalendarID?: string;
      transactionDetails?: unknown;
      [k: string]: unknown;
    }>("/session-status");
  }

  calendars() {
    return this.call<{ calendars: { bookingCalendarID: string; metadata?: { header?: string } }[] }>(
      "/calendars",
      {},
      { auth: true },
    );
  }

  calendarAvailability(bookingCalendarID: string, month: string) {
    return this.call<{ calendarMode?: string; availability: Record<string, { availabilityStatus: AvailabilityStatus }> }>(
      "/calendar-availability",
      { bookingCalendarID, month },
      { auth: true },
    );
  }

  calendarRates(dateOnly: string) {
    return this.call<{ rates: Record<string, RateMini> }>("/calendar-rates", { dateOnly }, { auth: true });
  }

  selectRate(inventoryTreeRateMiniID: string) {
    return this.call("/select-rate", { inventoryTreeRateMiniID }, { auth: true });
  }

  plate(plate: string) {
    return this.call("/plate", { plate, plateEntrySkipped: false });
  }

  checkout() {
    return this.call<{ transactionDetails?: { paymentFlow?: string; amountDue?: number; [k: string]: unknown } }>(
      "/checkout",
    );
  }

  paymentIntent(contact: { email: string; phone?: string }, setup = false) {
    return this.call<{ requiresPayment?: boolean; clientSecret?: string | null; customerSessionClientSecret?: string }>(
      setup ? "/setup-intent" : "/payment-intent",
      { email: contact.email, phone: contact.phone ?? "", contactType: "Email" },
      { auth: true },
    );
  }

  confirmPayment(setup = false) {
    return this.call<{ receiptID?: string }>(setup ? "/confirm-setup-intent" : "/confirm-payment");
  }

  currentReservations(locationID: string | null = null) {
    return this.call<{ reservations: Record<string, unknown>[] }>("/current-reservations", { locationID }, { auth: true });
  }

  cancelReservation(args: { reservationID: string; locationID: string; enterpriseID: string }) {
    return this.call("/cancel-reservation", args, { auth: true });
  }

  account() {
    return this.call<InflowUser>("/account", {}, { auth: true, base: GATED_API });
  }

  /**
   * Replace the whole Inflow user record (gated `PUT /appuser`), as the Inflow app does to edit saved plates.
   * Pass the record exactly as `/account` returned it, changing only what should change.
   */
  updateAppUser(user: InflowUser) {
    return this.call("/appuser", { ...user }, { auth: true, base: GATED_API, method: "PUT" });
  }

  /** Change the plate on a booked reservation. `receiptID` is the reservation's latest receipt. */
  plateUpdate(args: { newPlate: string; reservationID: string; receiptID: string }) {
    return this.call("/plate-update", args);
  }
}

export interface SavedPlate {
  plate: string;
  nickname?: string;
  state?: string;
  lastUsed?: string;
}

/** Inflow user record from gated `/account`. Other fields pass through untouched on `PUT /appuser`. */
export interface InflowUser {
  first?: string;
  savedPlates?: SavedPlate[];
  [k: string]: unknown;
}

/** Claims of the (unverified) welcome session JWT: enterpriseID, marketID, locationID, exp... */
export function sessionClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}
