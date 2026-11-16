import { describe, expect, it } from "vitest";
import {
  compareVersions,
  entryState,
  isNewPublisher,
  plainManagement,
  publicVersions,
  publisherLimits,
  summary,
  versionStatus,
  visibleFeatured,
  type StoredVersion,
} from "./rules.ts";

const version = (number: string, fields: Partial<StoredVersion> = {}): StoredVersion => ({
  version: number,
  hash: number.replaceAll(".", "").padEnd(64, "0"),
  size: 10,
  published: 1,
  listing: {
    title: `Notes ${number}`,
    line: `Line ${number}`,
    description: "",
    categories: ["calm"],
    keywords: [],
  },
  listed: true,
  withdrawn: undefined,
  reviewed: false,
  byAce: false,
  downloads: 0,
  ...fields,
});

describe("listing rules", () => {
  it("orders versions by their numbers, a release after its pre-releases", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-beta", "2.0.0-rc.1", "1.2.1"].toSorted(
      compareVersions,
    );
    expect(sorted).toEqual(["1.2.0-beta", "1.2.0", "1.2.1", "1.10.0", "2.0.0-rc.1"]);
  });

  it("an entry with no signed version isn't listed", () => {
    expect(entryState("notes", [version("1.0.0", { listed: false })])).toMatchObject({
      listed: false,
      latest: undefined,
      title: "notes",
    });
  });

  it("latest is the newest signed version that isn't withdrawn, with its words and review", () => {
    const state = entryState("notes", [
      version("1.0.0", { reviewed: true }),
      version("1.2.0", { withdrawn: "Broken." }),
      version("1.3.0", { listed: false }),
      version("1.1.0", { reviewed: true, byAce: true }),
    ]);
    expect(state).toMatchObject({
      listed: true,
      latest: "1.1.0",
      title: "Notes 1.1.0",
      reviewed: true,
      byAce: true,
    });
  });

  it("an entry whose every signed version is withdrawn leaves the index but keeps its words", () => {
    const state = entryState("notes", [version("1.0.0", { withdrawn: "Broken.", reviewed: true })]);
    expect(state).toMatchObject({
      listed: false,
      latest: undefined,
      title: "Notes 1.0.0",
      reviewed: false,
    });
  });

  it("an entry not reviewed names no categories in the index", () => {
    const row = {
      ...entryState("notes", [version("1.0.0")]),
      type: "spade-skill",
      name: "notes",
      publisher: { id: "pub_1", name: "tester" },
      updated: 5,
      downloads: 2,
    };
    expect(summary(row).categories).toEqual([]);
    expect(summary({ ...row, reviewed: true }).categories).toEqual(["calm"]);
  });

  it("an entry page shows signed versions only, newest first, with withdrawal reasons", () => {
    const shown = publicVersions([
      version("1.0.0"),
      version("2.0.0", { listed: false }),
      version("1.1.0", { withdrawn: "Broken." }),
    ]);
    expect(shown.map((row) => [row.version, row.withdrawn])).toEqual([
      ["1.1.0", "Broken."],
      ["1.0.0", undefined],
    ]);
  });

  it("featured keeps only entries still listed and reviewed, in order", () => {
    const entries = new Map([
      ["suit/a", { listed: true, reviewed: true }],
      ["suit/b", { listed: true, reviewed: false }],
      ["suit/c", { listed: false, reviewed: true }],
      ["suit/d", { listed: true, reviewed: true }],
    ]);
    const list = ["d", "b", "a", "c", "e"].map((name) => ({ type: "suit", name }));
    expect(visibleFeatured(list, entries).map((item) => item.name)).toEqual(["d", "a"]);
  });
});

describe("an entry's management (ADR 0173 §5)", () => {
  const versions = [version("1.0.0", { reviewed: true }), version("1.1.0")];

  it.each([
    ["listed, with a live version and an active publisher", {}, true],
    ["unlisted", { visibility: "unlisted" as const }, false],
    ["archived", { archived: true }, false],
    ["its publisher suspended", { publisherActive: false }, false],
  ])("an entry %s is in the index: %s", (_label, manage, listed) => {
    const state = entryState("notes", versions, { ...plainManagement, ...manage });
    expect(state.listed).toBe(listed);
    // Unlisted and archived entries keep their latest, so their page and objects still answer.
    expect(state.latest).toBe("1.1.0");
  });

  it("the publisher's pick of a live version is the latest, the rollback; a pick no longer live isn't", () => {
    const picked = entryState("notes", versions, { ...plainManagement, latestPick: "1.0.0" });
    expect(picked).toMatchObject({ latest: "1.0.0", reviewed: true, title: "Notes 1.0.0" });
    const gone = entryState(
      "notes",
      [version("1.0.0", { withdrawn: "Broken." }), version("1.1.0")],
      { ...plainManagement, latestPick: "1.0.0" },
    );
    expect(gone.latest).toBe("1.1.0");
  });

  it("an approved listing edit's words show over the version's own", () => {
    const state = entryState("notes", versions, {
      ...plainManagement,
      listing: {
        title: "Better notes",
        line: "A clearer line",
        description: "More.",
        categories: ["calm"],
        keywords: ["notes"],
        links: [],
        previews: [],
      },
    });
    expect(state).toMatchObject({ title: "Better notes", line: "A clearer line", latest: "1.1.0" });
  });

  it("the latest version's deprecation and the publisher's mark reach the index", () => {
    const state = entryState("notes", [version("1.0.0", { deprecated: "Use 2.x." })], {
      ...plainManagement,
      publisherVerified: true,
    });
    const row = {
      ...state,
      type: "suit",
      name: "notes",
      publisher: { id: "p", name: "n" },
      updated: 1,
      downloads: 0,
    };
    expect(summary(row)).toMatchObject({ verified: true, deprecated: "Use 2.x." });
  });

  it("an approved listing edit's pictures reach the index, so cards draw them", () => {
    const row = {
      ...entryState("notes", [version("1.0.0")]),
      type: "suit",
      name: "notes",
      publisher: { id: "p", name: "n" },
      updated: 1,
      downloads: 0,
    };
    expect(summary({ ...row, previews: ["a".repeat(64)] }).previews).toEqual(["a".repeat(64)]);
    expect(summary(row)).not.toHaveProperty("previews");
  });

  it.each([
    [
      "blocked by the scan",
      { listed: false, state: "blocked" as const, blockReason: "Runs a download." },
      "blocked",
      false,
    ],
    ["withdrawn", { withdrawn: "Broken." }, "withdrawn", false],
    ["signed and reviewed", { reviewed: true }, "live", false],
    ["signed, no review mark", {}, "not-reviewed", false],
    ["waiting for the signer", { listed: false, state: "pending" as const }, "waiting", false],
    ["held for a maintainer", { listed: false, state: "held" as const }, "waiting", true],
  ])("a version %s shows %s", (_label, fields, status, held) => {
    expect(versionStatus(version("1.0.0", fields))).toMatchObject({ status, held });
  });

  it.each([
    ["a week old", 7, 5, true],
    ["old, with two live versions", 60, 2, true],
    ["old, with three live versions", 60, 3, false],
  ])("a publisher %s is new: %s", (_label, days, live, expected) => {
    const now = 100 * 86_400_000;
    expect(isNewPublisher({ created: now - days * 86_400_000, liveVersions: live }, now)).toBe(
      expected,
    );
  });

  it("a new publisher's limits are stricter", () => {
    expect(publisherLimits(true)).toMatchObject({
      uploadsPerDay: 10,
      quotaBytes: 256 * 1024 * 1024,
    });
    expect(publisherLimits(false)).toMatchObject({
      uploadsPerDay: 30,
      quotaBytes: 1024 * 1024 * 1024,
      draftLimit: 20,
    });
  });
});
