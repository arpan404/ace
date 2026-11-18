import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeBase64url,
  grantPublicKey,
  MARKET_GRANT_ISSUER,
  signMarketGrant,
} from "@ace/account-grant";
import type { MarketOperation } from "@ace/protocol/marketplace";
import {
  freshSignInMs,
  hostMarketRefusal,
  needsFreshSignIn,
  signedInRecently,
  verifiedSignInFresh,
} from "./fresh-sign-in.ts";

const entry = { type: "suit", name: "dusk-harbor" } as const;
const publish = (
  request: Extract<MarketOperation, { op: "publish" }>["request"],
): MarketOperation => ({ op: "publish", request });
const install: MarketOperation = {
  op: "install",
  id: "rv-1",
  hash: "a".repeat(64),
  choices: { bots: [], needs: {}, startRoutines: false },
};

describe("which market actions need a sign-in from the last ten minutes", () => {
  it.each<[string, MarketOperation]>([
    ["installing", install],
    ["withdrawing", publish({ action: "withdraw", ...entry, reason: "Broken" })],
    ["transferring", publish({ action: "transfer", ...entry, to: "rijan" })],
    [
      "accepting a transfer",
      publish({ action: "transferAnswer", id: "trf_abcdefgh", accept: true }),
    ],
    ["changing the handle", publish({ action: "changeHandle", handle: "newname" })],
    ["deleting an entry", publish({ action: "deleteEntry", ...entry })],
    ["applying for verification", publish({ action: "applyVerification" })],
    ["checking verification", publish({ action: "checkVerification" })],
  ])("%s does", (_what, operation) => {
    expect(needsFreshSignIn(operation)).toBe(true);
  });

  it.each<[string, MarketOperation]>([
    ["a search", { op: "search", query: "", offset: 0, limit: 50 }],
    ["a draft", publish({ action: "draftRead", id: "drf_abcdefgh" })],
    ["publishing a draft", publish({ action: "draftPublish", id: "drf_abcdefgh" })],
    ["preparing a review", { op: "prepare", source: "market", ...entry }],
  ])("%s doesn't", (_what, operation) => {
    expect(needsFreshSignIn(operation)).toBe(false);
  });
});

describe("a sign-in counts as fresh for ten minutes before its grant", () => {
  it.each([
    [1_000, true],
    [0, true],
    [freshSignInMs, true],
    [freshSignInMs + 1, false],
    [-10 * 60_000, false],
    [undefined, false],
  ])("signed in %s ms before the grant: %s", (age, fresh) => {
    expect(signedInRecently(age)).toBe(fresh);
  });
});

const fresh = (value: boolean) => async () => value;

describe("a person-only market action from the host token, with no thread", () => {
  it("is refused without a fresh sign-in: the host token alone may be an agent", async () => {
    const refusal = await hostMarketRefusal({
      operation: install,
      unproven: true,
      fresh: fresh(false),
    });
    expect(refusal).toMatchObject({ op: "error", code: "reauth" });
    expect(refusal?.op === "error" && refusal.message).toMatch(/app|paired device/);
  });

  it("runs after a sign-in in the last ten minutes", async () => {
    expect(
      await hostMarketRefusal({ operation: install, unproven: true, fresh: fresh(true) }),
    ).toBeUndefined();
  });

  it("from the app or a paired device needs nothing more", async () => {
    let asked = false;
    const result = await hostMarketRefusal({
      operation: install,
      unproven: false,
      fresh: async () => {
        asked = true;
        return false;
      },
    });
    expect(result).toBeUndefined();
    expect(asked).toBe(false);
  });

  it("a search needs nothing more, wherever it comes from", async () => {
    expect(
      await hostMarketRefusal({
        operation: { op: "search", query: "", offset: 0, limit: 50 },
        unproven: true,
        fresh: fresh(false),
      }),
    ).toBeUndefined();
  });
});

describe("a sign-in counts as fresh only from a grant the trusted backend signed", () => {
  const trusted = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
  // A backend a host-token holder runs, publishing a key under the same id.
  const forger = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
  const now = 1_000_000_000;
  const trust = { keys: { keys: [grantPublicKey(trusted)] }, issuer: MARKET_GRANT_ISSUER, now };
  const grant = (
    key: typeof trusted,
    claims: { authAt?: number; iss?: string; exp?: number } = {},
  ) =>
    signMarketGrant(
      {
        kind: "machine",
        account: "user_1",
        subject: "host",
        iat: now,
        exp: claims.exp ?? now + 60_000,
        iss: claims.iss ?? MARKET_GRANT_ISSUER,
        emailVerified: true,
        authAt: claims.authAt ?? now - 1_000,
      },
      key,
    );

  it("is fresh for a recent sign-in in a grant the trusted backend signed", () => {
    expect(verifiedSignInFresh(grant(trusted), trust)).toBe(true);
  });

  it("isn't fresh for an old sign-in, however well signed", () => {
    expect(verifiedSignInFresh(grant(trusted, { authAt: now - 11 * 60_000 }), trust)).toBe(false);
  });

  it.each([
    ["signed by another backend's key", () => grant(forger)],
    [
      "carrying no valid signature",
      () => `${grant(trusted).split(".")[0]}.${encodeBase64url(new Uint8Array(64))}`,
    ],
    [
      "with its claims rewritten after signing",
      () => {
        const [, signature] = grant(trusted, { authAt: now - 11 * 60_000 }).split(".");
        const body = grant(trusted).split(".")[0];
        return `${body}.${signature}`;
      },
    ],
    ["from another issuer", () => grant(trusted, { iss: "evil.example" })],
    ["expired", () => grant(trusted, { exp: now - 1 })],
    ["not a grant at all", () => "not-a-grant"],
  ])("isn't fresh for a recent-looking sign-in %s", (_what, make) => {
    expect(verifiedSignInFresh(make(), trust)).toBe(false);
  });
});
