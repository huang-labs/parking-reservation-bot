import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { cognitoTimestamp, largeA, padHex, passwordAuthKey, passwordClaimSignature } from "../../src/inflow/cognito";

const require = createRequire(import.meta.url);
const AuthenticationHelper = require("amazon-cognito-identity-js/lib/AuthenticationHelper").default;
const BigInteger = require("amazon-cognito-identity-js/lib/BigInteger").default;

function refKey(poolName: string, userId: string, pw: string, a: bigint, B: bigint, salt: bigint): Promise<Uint8Array> {
  const h = new AuthenticationHelper(poolName);
  h.smallAValue = new BigInteger(a.toString(16), 16);
  h.largeAValue = undefined; // constructor precomputes A from its own random a
  return new Promise((resolve, reject) =>
    h.getLargeAValue((err: unknown, A: { toString(r: number): string }) => {
      if (err) return reject(err);
      expect(A.toString(16)).toBe(largeA(a).toString(16));
      h.getPasswordAuthenticationKey(
        userId, pw, new BigInteger(B.toString(16), 16), new BigInteger(salt.toString(16), 16),
        (e2: unknown, key: Uint8Array) => (e2 ? reject(e2) : resolve(new Uint8Array(key))),
      );
    }),
  );
}

describe("cognito SRP", () => {
  it("padHex matches two's-complement convention", () => {
    expect(padHex(0x14n)).toBe("14");
    expect(padHex(0xecn)).toBe("00ec");
    expect(padHex(0xabcn)).toBe("0abc");
  });

  it("formats timestamps like Cognito expects", () => {
    expect(cognitoTimestamp(new Date(Date.UTC(2026, 10, 7, 3, 4, 5)))).toBe("Sat Nov 7 03:04:05 UTC 2026");
  });

  it.each([
    [0x1234567890abcdefn, 0xdeadbeefcafebaben ** 9n, 0x8badf00dn ** 3n],
    [0xfedcba9876543210n ** 7n, 0x7n ** 500n, 0xc0ffeen],
  ])("derives the same password auth key as amazon-cognito-identity-js (%#)", async (a, B, salt) => {
    const args = { poolName: "OAjdb1vtY", userId: "4b1e-uuid-user", password: "hunter2 ✓", smallA: a, B, salt };
    const mine = await passwordAuthKey(args);
    const ref = await refKey(args.poolName, args.userId, args.password, a, B, salt);
    expect(Buffer.from(mine).toString("hex")).toBe(Buffer.from(ref).toString("hex"));

    const sig = await passwordClaimSignature({ key: mine, poolName: args.poolName, userId: args.userId,
      secretBlock: Buffer.from("secret-block").toString("base64"), timestamp: "Sat Nov 7 03:04:05 UTC 2026" });
    expect(sig).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
