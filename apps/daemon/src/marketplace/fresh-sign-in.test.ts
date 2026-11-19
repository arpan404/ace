import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import { hostMarketStanding, needsPerson } from "./fresh-sign-in.ts";

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
    [
      "turning a skill on for bots",
      { op: "turnOnForBots", name: "triage-mail", hash: "a".repeat(64) },
    ],
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

/** The gate's answer for `operation`, from a socket that did or didn't prove the person. */
const standing = (operation: MarketOperation, unproven: boolean, contentOnly = false) =>
  hostMarketStanding({ operation, unproven, contentOnly: () => contentOnly });

describe("a person-only market action without a thread", () => {
  it("is refused from a socket that hasn't proved the person's standing", () => {
    const decided = standing(install, true);
    expect(decided).toMatchObject({ refusal: { op: "error", code: "reauth" } });
    expect(
      "refusal" in decided && decided.refusal.op === "error" && decided.refusal.message,
    ).toMatch(/app/);
  });

  it("runs as the person from a socket that proved it", () => {
    expect(standing(install, false)).toEqual({ run: "person" });
  });

  it("a search needs nothing more, wherever it comes from", () => {
    expect(standing({ op: "search", query: "", offset: 0, limit: 50 }, true)).not.toHaveProperty(
      "refusal",
    );
  });

  it("installing content only runs without the person, so a skill waits for them", () => {
    expect(standing(install, true, true)).toEqual({ run: "without-person" });
  });

  it("content only from a proven socket is still the person's install", () => {
    expect(standing(install, false, true)).toEqual({ run: "person" });
  });

  it("content only is an install's exemption: withdrawing and turning a skill on for bots aren't", () => {
    const withdraw = publish({ action: "withdraw", ...entry, reason: "Broken" });
    const turnOn: MarketOperation = {
      op: "turnOnForBots",
      name: "triage-mail",
      hash: "a".repeat(64),
    };
    for (const operation of [withdraw, turnOn])
      expect(standing(operation, true, true)).toMatchObject({ refusal: { code: "reauth" } });
  });
});
