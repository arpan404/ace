import { describe, expect, it } from "vitest";
import {
  compareVersions,
  entryState,
  publicVersions,
  summary,
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
