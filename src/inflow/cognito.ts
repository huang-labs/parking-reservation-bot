/**
 * AWS Cognito user-pool auth for Inflow accounts, Worker-compatible (WebCrypto + BigInt only).
 *
 * Supports USER_PASSWORD_AUTH (if the app client allows it), USER_SRP_AUTH (what the Inflow
 * web app uses), and REFRESH_TOKEN_AUTH. SRP math mirrors amazon-cognito-identity-js
 * (AuthenticationHelper.js) and is cross-checked against it in test/cognito.test.ts.
 */

export const INFLOW_POOL = {
  region: "us-east-2",
  userPoolId: "us-east-2_OAjdb1vtY",
  clientId: "2rgie6ca69hfcjh76hjrkjclei",
} as const;

export interface CognitoTokens {
  idToken: string;
  accessToken: string;
  /** Absent on REFRESH_TOKEN_AUTH responses (the original refresh token stays valid). */
  refreshToken?: string;
  expiresIn: number;
}

export class CognitoError extends Error {
  constructor(
    public readonly type: string,
    message: string,
    public readonly status: number,
  ) {
    super(`${type}: ${message}`);
  }
}

// ---------- SRP constants & bigint helpers ----------

const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
const N = BigInt("0x" + N_HEX);
const g = 2n;

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const utf8 = (str: string): Bytes => new Uint8Array(enc.encode(str));

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}

/** Even-length hex, with a leading 00 if the MSB is set (positive two's complement). */
export function padHex(n: bigint): string {
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  if (/^[89a-f]/i.test(h)) h = "00" + h;
  return h;
}

export function hexToBytes(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Bytes): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hexHash(hex: string): Promise<string> {
  return bytesToHex(await sha256(hexToBytes(hex)));
}

function b64encode(b: Bytes): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function b64decode(s: string): Bytes {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Cognito's timestamp format: "Tue Nov 7 03:04:05 UTC 2026" (day unpadded). */
export function cognitoTimestamp(d = new Date()): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

// ---------- SRP core (exported for tests) ----------

export function randomSmallA(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(128));
  return mod(BigInt("0x" + bytesToHex(b)), N);
}

export function largeA(smallA: bigint): bigint {
  const A = modPow(g, smallA, N);
  if (A % N === 0n) throw new Error("Illegal A");
  return A;
}

/** HKDF-derived 16-byte password authentication key. */
export async function passwordAuthKey(args: {
  poolName: string;
  userId: string;
  password: string;
  smallA: bigint;
  B: bigint;
  salt: bigint;
}): Promise<Bytes> {
  const { poolName, userId, password, smallA, B, salt } = args;
  if (B % N === 0n) throw new Error("B cannot be zero");
  const A = largeA(smallA);
  const k = BigInt("0x" + (await hexHash(padHex(N) + padHex(g))));
  const u = BigInt("0x" + (await hexHash(padHex(A) + padHex(B))));
  if (u === 0n) throw new Error("U cannot be zero");
  const upHash = bytesToHex(await sha256(utf8(`${poolName}${userId}:${password}`)));
  const x = BigInt("0x" + (await hexHash(padHex(salt) + upHash)));
  const S = modPow(B - k * modPow(g, x, N), smallA + u * x, N);
  const prk = await hmac(hexToBytes(padHex(u)), hexToBytes(padHex(S)));
  const okm = await hmac(prk, concat(utf8("Caldera Derived Key"), new Uint8Array([1])));
  return okm.slice(0, 16);
}

export async function passwordClaimSignature(args: {
  key: Bytes;
  poolName: string;
  userId: string;
  secretBlock: string;
  timestamp: string;
}): Promise<string> {
  const msg = concat(
    utf8(args.poolName),
    utf8(args.userId),
    b64decode(args.secretBlock),
    utf8(args.timestamp),
  );
  return b64encode(await hmac(args.key, msg));
}

// ---------- Cognito JSON API ----------

type Fetch = typeof fetch;

async function idp<T>(target: string, body: unknown, f: Fetch = fetch): Promise<T> {
  const res = await f(`https://cognito-idp.${INFLOW_POOL.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(json.__type ?? "Unknown").split("#").pop()!;
    throw new CognitoError(type, String(json.message ?? json.Message ?? ""), res.status);
  }
  return json as T;
}

interface AuthResult {
  AuthenticationResult?: {
    IdToken: string;
    AccessToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
  };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

function toTokens(r: AuthResult, step: string): CognitoTokens {
  const a = r.AuthenticationResult;
  if (!a) throw new CognitoError("UnexpectedChallenge", `${step}: challenge ${r.ChallengeName ?? "none"}`, 200);
  return { idToken: a.IdToken, accessToken: a.AccessToken, refreshToken: a.RefreshToken, expiresIn: a.ExpiresIn };
}

export async function loginPassword(email: string, password: string, f?: Fetch): Promise<CognitoTokens> {
  const r = await idp<AuthResult>(
    "InitiateAuth",
    { AuthFlow: "USER_PASSWORD_AUTH", ClientId: INFLOW_POOL.clientId, AuthParameters: { USERNAME: email, PASSWORD: password } },
    f,
  );
  return toTokens(r, "USER_PASSWORD_AUTH");
}

export async function loginSrp(email: string, password: string, f?: Fetch): Promise<CognitoTokens> {
  const poolName = INFLOW_POOL.userPoolId.split("_")[1]!;
  const smallA = randomSmallA();
  const A = largeA(smallA);
  const init = await idp<AuthResult>(
    "InitiateAuth",
    {
      AuthFlow: "USER_SRP_AUTH",
      ClientId: INFLOW_POOL.clientId,
      AuthParameters: { USERNAME: email, SRP_A: A.toString(16) },
    },
    f,
  );
  if (init.ChallengeName !== "PASSWORD_VERIFIER" || !init.ChallengeParameters) {
    throw new CognitoError("UnexpectedChallenge", `SRP init: ${init.ChallengeName}`, 200);
  }
  const p = init.ChallengeParameters;
  const userId = p.USER_ID_FOR_SRP!;
  const key = await passwordAuthKey({
    poolName,
    userId,
    password,
    smallA,
    B: BigInt("0x" + p.SRP_B!),
    salt: BigInt("0x" + p.SALT!),
  });
  const timestamp = cognitoTimestamp();
  const signature = await passwordClaimSignature({ key, poolName, userId, secretBlock: p.SECRET_BLOCK!, timestamp });
  const r = await idp<AuthResult>(
    "RespondToAuthChallenge",
    {
      ChallengeName: "PASSWORD_VERIFIER",
      ClientId: INFLOW_POOL.clientId,
      Session: init.Session,
      ChallengeResponses: {
        USERNAME: userId,
        PASSWORD_CLAIM_SECRET_BLOCK: p.SECRET_BLOCK,
        PASSWORD_CLAIM_SIGNATURE: signature,
        TIMESTAMP: timestamp,
      },
    },
    f,
  );
  return toTokens(r, "SRP verify");
}

/** Tries USER_PASSWORD_AUTH, falls back to SRP if the client doesn't allow it. */
export async function login(
  email: string,
  password: string,
  f?: Fetch,
): Promise<CognitoTokens & { flow: "password" | "srp" }> {
  try {
    return { ...(await loginPassword(email, password, f)), flow: "password" };
  } catch (e) {
    if (e instanceof CognitoError && e.type === "InvalidParameterException") {
      return { ...(await loginSrp(email, password, f)), flow: "srp" };
    }
    throw e;
  }
}

export async function refresh(refreshToken: string, f?: Fetch): Promise<CognitoTokens> {
  const r = await idp<AuthResult>(
    "InitiateAuth",
    { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: INFLOW_POOL.clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } },
    f,
  );
  return toTokens(r, "refresh");
}

/** Decode a JWT payload without verifying (we only read our own tokens' claims). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(new TextDecoder().decode(b64decode(b64)));
}
