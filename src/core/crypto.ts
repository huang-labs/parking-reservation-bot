/** AES-256-GCM for stored Inflow passwords. Key: base64 of 32 random bytes (CREDS_ENC_KEY). */

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("CREDS_ENC_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await key(secret),
    new TextEncoder().encode(plaintext),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decrypt(secret: string, blob: string, aad: string): Promise<string> {
  const [iv, ct] = blob.split(".");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv!), additionalData: new TextEncoder().encode(aad) },
    await key(secret),
    unb64(ct!),
  );
  return new TextDecoder().decode(pt);
}

export function randomId(len = 10): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => alphabet[b % alphabet.length]).join("");
}
