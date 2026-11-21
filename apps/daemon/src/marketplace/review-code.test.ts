import { describe, expect, it } from "vitest";
import { checkFiles } from "@ace/marketplace/checks";
import { folder, samplePackage } from "@ace/marketplace/testing";
import { buildReview, type PreparedReview } from "./review.ts";

/* A bot package's own code on its install review (ADR 0203 §5): a row per component. */

const component = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00);

function review(files: ReturnType<typeof samplePackage>): PreparedReview {
  const checked = checkFiles("spade-bot", "flight-watcher", files);
  expect(checked.problems).toEqual([]);
  return {
    id: "rv-1",
    expiresAt: 1,
    source: "market",
    type: "spade-bot",
    name: "flight-watcher",
    title: "Flight watcher",
    version: "1",
    hash: checked.hash,
    signed: true,
    reviewed: true,
    byAce: false,
    checked,
    brings: [],
    spadeReady: true,
  };
}

describe("the review of a package with code", () => {
  it("shows a row per component saying what its code can reach", () => {
    const code = [
      {
        name: "fares",
        file: "code/fares.wasm",
        world: "spade:package/bot-tools@1.0.0",
        imports: ["spade:package/http", "spade:package/tools"],
        why: "Picks the cheapest fare.",
      },
    ];
    const files = [...samplePackage({ code }), ...folder({ "code/fares.wasm": component })];
    const body = buildReview(review(files)).review.body;
    expect(body.type === "spade-bot" && body.code).toEqual([
      {
        name: "fares",
        imports: ["spade:package/http", "spade:package/tools"],
        why: "Picks the cheapest fare.",
        sentence:
          "Runs its own code: fares. It can reach api.example-fares.com and call Spade's tools as this bot.",
      },
    ]);
  });

  it("has no code rows for a package without code", () => {
    const body = buildReview(review(samplePackage())).review.body;
    expect(body.type === "spade-bot" && body.code).toBeUndefined();
  });
});
