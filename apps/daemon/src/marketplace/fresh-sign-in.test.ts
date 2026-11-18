import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import {
  freshSignInMs,
  hostMarketRefusal,
  needsFreshSignIn,
  signedInRecently,
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
      hostTokenOnly: true,
      fresh: fresh(false),
    });
    expect(refusal).toMatchObject({ op: "error", code: "reauth" });
    expect(refusal?.op === "error" && refusal.message).toMatch(/app|paired device/);
  });

  it("runs after a sign-in in the last ten minutes", async () => {
    expect(
      await hostMarketRefusal({ operation: install, hostTokenOnly: true, fresh: fresh(true) }),
    ).toBeUndefined();
  });

  it("from the app or a paired device needs nothing more", async () => {
    let asked = false;
    const result = await hostMarketRefusal({
      operation: install,
      hostTokenOnly: false,
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
        hostTokenOnly: true,
        fresh: fresh(false),
      }),
    ).toBeUndefined();
  });
});
