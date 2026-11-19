import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import { hostMarketRefusal, needsPerson } from "./fresh-sign-in.ts";

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

describe("which market actions are the person's", () => {
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
    expect(needsPerson(operation)).toBe(true);
  });

  it.each<[string, MarketOperation]>([
    ["a search", { op: "search", query: "", offset: 0, limit: 50 }],
    ["a draft", publish({ action: "draftRead", id: "drf_abcdefgh" })],
    ["publishing a draft", publish({ action: "draftPublish", id: "drf_abcdefgh" })],
    ["preparing a review", { op: "prepare", source: "market", ...entry }],
  ])("%s doesn't", (_what, operation) => {
    expect(needsPerson(operation)).toBe(false);
  });
});

describe("a person-only market action without a thread", () => {
  it("is refused from a socket that hasn't proved the person's standing", () => {
    const refusal = hostMarketRefusal({ operation: install, unproven: true });
    expect(refusal).toMatchObject({ op: "error", code: "reauth" });
    expect(refusal?.op === "error" && refusal.message).toMatch(/app/);
  });

  it("runs from a socket that proved it", () => {
    expect(hostMarketRefusal({ operation: install, unproven: false })).toBeUndefined();
  });

  it("a search needs nothing more, wherever it comes from", () => {
    expect(
      hostMarketRefusal({
        operation: { op: "search", query: "", offset: 0, limit: 50 },
        unproven: true,
      }),
    ).toBeUndefined();
  });
});
