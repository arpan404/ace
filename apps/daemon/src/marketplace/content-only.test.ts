import { describe, expect, it } from "vitest";
import { checkFiles } from "@ace/marketplace/checks";
import { folder, sampleSkill, sampleSuit } from "@ace/marketplace/testing";
import type { ArchiveFile } from "@ace/marketplace";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { contentOnlyReview } from "./content-only.ts";
import { buildReview, type PreparedReview } from "./review.ts";

/** A review as prepare builds one from `files`, checked as `type`. */
function prepared(
  type: MarketEntryType,
  name: string,
  files: ArchiveFile[],
  extra: Partial<PreparedReview> = {},
): PreparedReview {
  const checked = checkFiles(type, name, files);
  return {
    id: "rv-1",
    expiresAt: 1,
    source: "market",
    type,
    name,
    title: name,
    version: "1",
    hash: checked.hash,
    signed: true,
    reviewed: true,
    byAce: false,
    checked,
    brings: [],
    spadeReady: true,
    ...extra,
  };
}
const contentOnly = (review: PreparedReview) =>
  contentOnlyReview(review, buildReview(review).review.body);

describe("which installs land content only", () => {
  it("a Suit", () => {
    expect(contentOnly(prepared("suit", "harbour-dusk", sampleSuit()))).toBe(true);
  });

  it("a Spade skill", () => {
    expect(contentOnly(prepared("spade-skill", "triage-mail", sampleSkill()))).toBe(true);
  });

  it("not a review that says suit but carries an executable file", () => {
    const files = [...sampleSuit(), ...folder({ "scenes/run.sh*": "#!/bin/sh\necho hi\n" })];
    expect(contentOnly(prepared("suit", "harbour-dusk", files))).toBe(false);
  });

  it("not a review that says suit but carries a plugin's executions", () => {
    const plugin = { executions: [] } as unknown as NonNullable<PreparedReview["plugin"]>;
    expect(contentOnly(prepared("suit", "harbour-dusk", sampleSuit(), { plugin }))).toBe(false);
  });

  it("not a review whose body is another type than it says", () => {
    const review = prepared("suit", "harbour-dusk", sampleSuit());
    const body = buildReview(prepared("spade-skill", "triage-mail", sampleSkill())).review.body;
    expect(contentOnlyReview(review, body)).toBe(false);
  });

  it("not a skill carrying an executable script", () => {
    const files = sampleSkill("triage-mail", {});
    files.push(...folder({ "scripts/sort.sh*": "#!/bin/sh\nexit 0\n" }));
    expect(contentOnly(prepared("spade-skill", "triage-mail", files))).toBe(false);
  });
});
