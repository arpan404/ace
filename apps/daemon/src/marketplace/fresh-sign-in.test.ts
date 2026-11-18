import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import {
  freshSignInMs,
  hostMarketRefusal,
  needsFreshSignIn,
  verifiedSignInFresh,
} from "./fresh-sign-in.ts";
import {
  GRANT_LIFETIME_MS,
  MARKET_GRANT_ISSUER,
  grantPublicKey,
  signMarketGrant,
} from "@ace/account-grant";

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

describe("a sign-in counts as fresh only from a pinned key's grant for this machine, for ten minutes", () => {
  const key = { id: "k1", privateKey: new Uint8Array(32).fill(5) };
  const keys = { keys: [grantPublicKey(key)] };
  const host = "H".repeat(52);
  const now = 10_000_000;
  const grant = (
    authAt: number,
    claims: Partial<{
      kind: "machine" | "device";
      account: string;
      subject: string;
      iss: string;
    }> = {},
    signer = key,
  ) =>
    signMarketGrant(
      {
        kind: "machine",
        account: "user_1",
        subject: host,
        iat: now - 1_000,
        exp: now - 1_000 + GRANT_LIFETIME_MS,
        iss: MARKET_GRANT_ISSUER,
        emailVerified: true,
        authAt,
        ...claims,
      },
      signer,
    );
  const check = (token: string) =>
    verifiedSignInFresh(token, {
      keys,
      issuer: MARKET_GRANT_ISSUER,
      now,
      account: "user_1",
      subject: host,
    });
  it.each<[string, string, boolean]>([
    ["signed in a minute ago", grant(now - 60_000), true],
    ["signed in nine minutes ago", grant(now - 9 * 60_000), true],
    ["signed in eleven minutes ago", grant(now - 11 * 60_000), false],
    ["a sign-in from the future", grant(now + 10 * 60_000), false],
    ["another account's", grant(now, { account: "user_2" }), false],
    ["another machine's", grant(now, { subject: "G".repeat(52) }), false],
    ["a device's", grant(now, { kind: "device" }), false],
    ["another backend's", grant(now, { iss: "attacker.example" }), false],
    [
      "signed by a key this build doesn't pin",
      grant(now, {}, { id: "k1", privateKey: new Uint8Array(32).fill(6) }),
      false,
    ],
    ["not a grant", "not.a-grant", false],
  ])("%s: %s", (_case, token, fresh) => {
    expect(check(token)).toBe(fresh);
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
