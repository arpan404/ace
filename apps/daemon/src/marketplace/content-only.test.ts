import { describe, expect, it } from "vitest";
import { checkFiles } from "@ace/marketplace/checks";
import { folder, sampleSkill, sampleSuit } from "@ace/marketplace/testing";
import type { ArchiveFile } from "@ace/marketplace";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { contentOnlyReview } from "./content-only.ts";
import { buildReview, type PreparedReview } from "./review.ts";
import type { StoredInstall } from "./store.ts";

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
const contentOnly = (review: PreparedReview, previous?: StoredInstall) =>
  contentOnlyReview(review, buildReview(review).review.body, previous);

/** The installed record a review would replace: from `source`, signed by `publisher` or not. */
function installed(
  review: PreparedReview,
  provenance: { source?: string; signed?: boolean; publisher?: string } = {},
): StoredInstall {
  return {
    source: provenance.source ?? review.source,
    type: review.type,
    name: review.name,
    title: review.title,
    version: "0.9",
    hash: "0".repeat(64),
    acceptedAt: 1,
    state: "on",
    files: [],
    description: "",
    ...("signed" in provenance ? { signed: provenance.signed } : { signed: review.signed }),
    ...(provenance.publisher ? { publisher: provenance.publisher } : {}),
  };
}

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
    expect(contentOnlyReview(review, body, undefined)).toBe(false);
  });

  it("not a skill carrying an executable script", () => {
    const files = sampleSkill("triage-mail", {});
    files.push(...folder({ "scripts/sort.sh*": "#!/bin/sh\nexit 0\n" }));
    expect(contentOnly(prepared("spade-skill", "triage-mail", files))).toBe(false);
  });
});

/** A Suit review signed by `publisher`. */
const signedBy = (publisher: string) =>
  prepared("suit", "harbour-dusk", sampleSuit(), {
    signed: true,
    publisher: { id: publisher, name: "tester" },
  });

describe("an update skips the person only from where the installed entry came from", () => {
  it("from the same source by the same publisher", () => {
    const review = signedBy("pub_a");
    expect(contentOnly(review, installed(review, { publisher: "pub_a" }))).toBe(true);
  });

  it("not from another source, such as a git catalog with the same name", () => {
    const review = prepared("suit", "harbour-dusk", sampleSuit(), {
      source: "git-1",
      signed: false,
    });
    expect(contentOnly(review, installed(review, { source: "market", signed: true }))).toBe(false);
  });

  it("not unsigned bytes over signed ones from the same source", () => {
    const review = prepared("suit", "harbour-dusk", sampleSuit(), { signed: false });
    expect(contentOnly(review, installed(review, { signed: true, publisher: "pub_a" }))).toBe(
      false,
    );
  });

  it("not from another publisher", () => {
    const review = signedBy("pub_b");
    expect(contentOnly(review, installed(review, { publisher: "pub_a" }))).toBe(false);
  });

  it("not over a record from before provenance was kept", () => {
    const review = signedBy("pub_a");
    const { signed: _signed, ...legacy } = installed(review, { publisher: "pub_a" });
    expect(contentOnly(review, legacy)).toBe(false);
  });
});
