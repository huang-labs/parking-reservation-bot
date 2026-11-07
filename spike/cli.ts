/**
 * Spike runner — proves the unknowns in docs/DESIGN.md §9 against a real Inflow account.
 * Usage: see spike/README.md.  State (tokens, sessions) is kept in .spike-state.json (gitignored).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CognitoError, jwtClaims, login, loginPassword, loginSrp, refresh } from "../src/inflow/cognito";
import { InflowError, InflowSession, LOTS, type LotKey, sessionClaims } from "../src/inflow/client";
import { confirmWithSavedCard, findPublishableKey, listSavedCards } from "../src/inflow/stripe";

if (existsSync(".env")) process.loadEnvFile(".env");

const STATE_FILE = ".spike-state.json";
const LOG_DIR = "spike/logs";
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

interface State {
  refreshToken?: string;
  idToken?: string;
  idTokenExp?: number;
  sessions: Partial<Record<LotKey, { token: string; calendarId?: string }>>;
  intent?: { lot: LotKey; clientSecret: string; customerSessionClientSecret?: string; setup: boolean };
}

const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { sessions: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (entry: unknown) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...(entry as object) }) + "\n");
const print = (label: string, v: unknown) => console.log(`\n── ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in .env`);
  return v;
}

async function idToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (state.idToken && (state.idTokenExp ?? 0) - 60 > now) return state.idToken;
  if (state.refreshToken) {
    try {
      const t = await refresh(state.refreshToken);
      state.idToken = t.idToken;
      state.idTokenExp = Number(jwtClaims(t.idToken).exp);
      save();
      return t.idToken;
    } catch (e) {
      console.warn("refresh failed, re-logging in:", (e as Error).message);
    }
  }
  const t = await login(env("INFLOW_EMAIL"), env("INFLOW_PASSWORD"));
  Object.assign(state, { refreshToken: t.refreshToken, idToken: t.idToken, idTokenExp: Number(jwtClaims(t.idToken).exp) });
  save();
  return t.idToken;
}

async function session(lot: LotKey, fresh = false): Promise<InflowSession> {
  let s = state.sessions[lot];
  if (!s || fresh) {
    s = { token: await InflowSession.welcome(lot) };
    state.sessions[lot] = s;
    save();
  }
  return new InflowSession(lot, s.token, idToken, {
    onCall: (c) => {
      log({ lot, ...c });
      console.log(`  ${c.status} ${c.path} (${c.ms}ms)`);
    },
  });
}

async function calendarId(lot: LotKey, s: InflowSession, pick?: string): Promise<string> {
  const { calendars } = await s.calendars();
  print(`${lot} calendars`, calendars.map((c) => ({ id: c.bookingCalendarID, header: c.metadata?.header })));
  const chosen = pick ? calendars.find((c) => c.bookingCalendarID === pick) : calendars[0];
  if (!chosen) throw new Error("no calendar");
  state.sessions[lot]!.calendarId = chosen.bookingCalendarID;
  save();
  return chosen.bookingCalendarID;
}

function lotArg(v: string | undefined): LotKey {
  if (!v || !(v in LOTS)) throw new Error(`lot must be one of: ${Object.keys(LOTS).join(", ")}`);
  return v as LotKey;
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  /** Q1: which auth flow works, token lifetimes, refresh. */
  async auth() {
    const email = env("INFLOW_EMAIL");
    const password = env("INFLOW_PASSWORD");
    let flow = "password";
    let t;
    try {
      t = await loginPassword(email, password);
      print("USER_PASSWORD_AUTH", "✅ works");
    } catch (e) {
      print("USER_PASSWORD_AUTH", `❌ ${(e as Error).message}`);
      if (!(e instanceof CognitoError)) throw e;
      flow = "srp";
      t = await loginSrp(email, password);
      print("USER_SRP_AUTH", "✅ works");
    }
    const id = jwtClaims(t.idToken);
    print("ID token claims", {
      flow,
      token_use: id.token_use,
      auth_time: id.auth_time,
      exp: id.exp,
      lifetime_s: Number(id.exp) - Number(id.iat),
      expiresIn: t.expiresIn,
      sub: id.sub,
      has_refresh: Boolean(t.refreshToken),
    });
    const r = await refresh(t.refreshToken!);
    print("REFRESH_TOKEN_AUTH", `✅ new id token, exp ${jwtClaims(r.idToken).exp}`);
    Object.assign(state, { refreshToken: t.refreshToken, idToken: r.idToken, idTokenExp: Number(jwtClaims(r.idToken).exp) });
    save();
    log({ cmd: "auth", flow, lifetime_s: Number(id.exp) - Number(id.iat) });
  },

  async welcome([lot]) {
    const s = await session(lotArg(lot), true);
    print("session claims", sessionClaims(s.sessionToken));
    print("session-status", await s.sessionStatus());
  },

  async account() {
    const s = await session("alta");
    print("account (gated)", await s.account());
  },

  /** Q2: read path. */
  async availability([lot, month, cal]) {
    const l = lotArg(lot);
    const s = await session(l);
    const id = await calendarId(l, s, cal);
    const res = await s.calendarAvailability(id, month ?? new Date().toISOString().slice(0, 7));
    print("availability", res);
  },

  async rates([lot, date, cal]) {
    const l = lotArg(lot);
    if (!date) throw new Error("rates <lot> <YYYY-MM-DD>");
    const s = await session(l);
    const id = await calendarId(l, s, cal);
    await s.calendarAvailability(id, date.slice(0, 7));
    const { rates } = await s.calendarRates(date);
    print(
      `rates ${l} ${date}`,
      Object.values(rates).map((r) => ({ id: r.inventoryTreeRateMiniID, name: r.rateName, status: r.rateStatus, price: r.finalPrice, due: r.expectedAmountDue })),
    );
  },

  /** Q3: hold duration. Run `rates` first in the same session. */
  async hold([lot, rateId]) {
    const l = lotArg(lot);
    if (!rateId) throw new Error("hold <lot> <rateId>  (rateId from `rates`)");
    const s = await session(l);
    const t0 = Date.now();
    print("select-rate", await s.selectRate(rateId));
    const st = await s.sessionStatus();
    print("session-status", st);
    if (st.holdReleaseTimestamp) {
      const secs = Math.round((Date.parse(st.holdReleaseTimestamp) - t0) / 1000);
      print("HOLD DURATION", `${secs}s (until ${st.holdReleaseTimestamp})`);
      log({ cmd: "hold", holdSeconds: secs });
    }
  },

  async checkout([lot, plate]) {
    const l = lotArg(lot);
    if (!plate) throw new Error("checkout <lot> <PLATE>");
    const s = await session(l);
    print("plate", await s.plate(plate));
    print("checkout", await s.checkout());
  },

  /** Q4 part 1: create the intent and list saved cards (no charge). */
  async intent([lot]) {
    const l = lotArg(lot);
    const s = await session(l);
    const st = await s.sessionStatus();
    const flow = (st.transactionDetails as { paymentFlow?: string } | undefined)?.paymentFlow;
    const setup = flow === "SetupIntent";
    print("paymentFlow", flow ?? "(unknown)");
    const pi = await s.paymentIntent({ email: env("INFLOW_EMAIL") }, setup);
    print("intent", { requiresPayment: pi.requiresPayment, hasClientSecret: Boolean(pi.clientSecret), hasCustomerSession: Boolean(pi.customerSessionClientSecret) });
    if (!pi.clientSecret) {
      print("FREE", "no Stripe step — run `confirm <lot>` to finish");
      return;
    }
    state.intent = { lot: l, clientSecret: pi.clientSecret, customerSessionClientSecret: pi.customerSessionClientSecret, setup };
    save();
    const pk = await findPublishableKey();
    print("publishable key", pk.slice(0, 16) + "…");
    if (pi.customerSessionClientSecret) {
      const r = await listSavedCards({ publishableKey: pk, clientSecret: pi.clientSecret, customerSessionClientSecret: pi.customerSessionClientSecret, setup });
      print("saved cards", r.cards.length ? r.cards : r.raw);
      log({ cmd: "intent", cards: r.cards.length, raw: r.raw });
    }
  },

  /** Q4 part 2: CHARGES THE CARD. Requires --yes-charge. */
  async pay([pm, flag]) {
    if (flag !== "--yes-charge") throw new Error("pay <pm_id> --yes-charge   (this charges the saved card)");
    const it = state.intent;
    if (!it) throw new Error("run `intent <lot>` first");
    const pk = await findPublishableKey();
    const out = await confirmWithSavedCard({ publishableKey: pk, clientSecret: it.clientSecret, paymentMethodId: pm!, setup: it.setup });
    print("stripe confirm", { kind: out.kind, ...(out.kind === "requires_action" ? { nextAction: out.nextAction } : {}), ...(out.kind === "failed" ? { error: out.error } : {}) });
    log({ cmd: "pay", outcome: out.kind, raw: out.raw });
    if (out.kind === "succeeded") await commands.confirm!([it.lot]);
  },

  async confirm([lot]) {
    const l = lotArg(lot);
    const s = await session(l);
    const setup = state.intent?.lot === l && state.intent.setup;
    for (let i = 0; i < 10; i++) {
      try {
        const r = await s.confirmPayment(setup);
        print("CONFIRMED", r);
        return;
      } catch (e) {
        if (e instanceof InflowError && /WebhookNotCompleted/.test(e.failReason ?? "")) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw e;
      }
    }
    print("confirm", "gave up after 10 tries");
  },

  async reservations([lot]) {
    const s = await session(lotArg(lot ?? "alta"));
    print("current reservations", await s.currentReservations(null));
  },

  /** Q5. */
  async cancel([lot, reservationID]) {
    const l = lotArg(lot);
    const s = await session(l);
    const c = sessionClaims(s.sessionToken) as { locationID: string; enterpriseID: string };
    print("cancel", await s.cancelReservation({ reservationID: reservationID!, locationID: c.locationID, enterpriseID: c.enterpriseID }));
  },

  async raw([lot, path, json]) {
    const s = await session(lotArg(lot));
    const body = json ? JSON.parse(json) : {};
    print(path!, await s.call(path!, body, { auth: "cognitoIDToken" in body || process.env.RAW_AUTH === "1" }));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.log(`commands: ${Object.keys(commands).join(", ")}  (see spike/README.md)`);
  process.exit(1);
}
fn(rest)
  .then(() => console.log(`\nlog: ${LOG_FILE}`))
  .catch((e) => {
    console.error(`\n✖ ${e instanceof InflowError ? `${e.message}\n${JSON.stringify(e.body, null, 2)}` : e.stack ?? e}`);
    log({ cmd, error: String(e), body: (e as InflowError).body });
    process.exit(1);
  });
