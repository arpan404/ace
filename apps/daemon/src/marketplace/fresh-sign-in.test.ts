import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeBase64url,
  grantPublicKey,
  MARKET_GRANT_ISSUER,
  signMarketGrant,
} from "@ace/account-grant";
import type { MarketOperation } from "@ace/protocol/marketplace";
import { hostMarketRefusal, needsFreshSignIn, verifiedSignInFresh } from "./fresh-sign-in.ts";

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

describe("a sign-in counts as fresh only from a grant this build trusts, for this machine, now", () => {
  const trusted = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
  // A backend a host-token holder runs, publishing a key under the same id.
  const forger = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
  const signedIn = 1_000_000_000;
  const trust = (now: number) => ({
    keys: { keys: [grantPublicKey(trusted)] },
    issuer: MARKET_GRANT_ISSUER,
    now,
    account: "user_1",
    subject: "host-1",
  });
  /** A market grant minted `at`, for a sign-in at `signedIn`. */
  const grant = (
    at: number,
    claims: { key?: typeof trusted; iss?: string; account?: string; subject?: string } = {},
    kind: "machine" | "device" = "machine",
  ) =>
    signMarketGrant(
      {
        kind,
        account: claims.account ?? "user_1",
        subject: claims.subject ?? "host-1",
        iat: at,
        exp: at + 5 * 60_000,
        iss: claims.iss ?? MARKET_GRANT_ISSUER,
        emailVerified: true,
        authAt: signedIn,
      },
      claims.key ?? trusted,
    );
  const minute = 60_000;

  it("is fresh for a grant taken and checked within ten minutes of the sign-in", () => {
    expect(verifiedSignInFresh(grant(signedIn + minute), trust(signedIn + minute))).toBe(true);
  });

  it("isn't fresh for a grant taken at 9m59s and replayed 5 minutes later, still unexpired", () => {
    const taken = signedIn + 9 * minute + 59_000;
    expect(verifiedSignInFresh(grant(taken), trust(taken))).toBe(true);
    expect(verifiedSignInFresh(grant(taken), trust(taken + 5 * minute - 1))).toBe(false);
  });

  it("isn't fresh for an old sign-in, however well signed", () => {
    const later = signedIn + 11 * minute;
    expect(verifiedSignInFresh(grant(later), trust(later))).toBe(false);
  });

  it("allows the backend's clock a minute ahead of this daemon's, and no more", () => {
    expect(verifiedSignInFresh(grant(signedIn), trust(signedIn - 59_000))).toBe(true);
    expect(verifiedSignInFresh(grant(signedIn), trust(signedIn - 2 * minute))).toBe(false);
  });

  const now = signedIn + minute;
  it.each([
    ["for another account", () => grant(now, { account: "user_2" })],
    ["for another machine", () => grant(now, { subject: "host-2" })],
    ["a device's grant rather than this machine's", () => grant(now, {}, "device")],
    ["signed by a key this build doesn't pin", () => grant(now, { key: forger })],
    [
      "carrying no valid signature",
      () => `${grant(now).split(".")[0]}.${encodeBase64url(new Uint8Array(64))}`,
    ],
    ["from another issuer", () => grant(now, { iss: "evil.example" })],
    ["not a grant at all", () => "not-a-grant"],
  ])("isn't fresh for a grant %s", (_what, make) => {
    expect(verifiedSignInFresh(make(), trust(now))).toBe(false);
  });
});
