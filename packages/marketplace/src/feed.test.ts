import { describe, expect, it } from "vitest";
import { parseCatalog } from "./catalog.ts";
import { mergeIndex, parseIndex } from "./feed.ts";

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "spade-skill",
  name,
  title: name.toUpperCase(),
  line: "One line.",
  categories: ["mail"],
  keywords: ["inbox"],
  version: "1.0.0",
  reviewed: true,
  byAce: false,
  updated: 10,
  downloads: 3,
  ...extra,
});

describe("the market index", () => {
  it("keeps an entry of a type this build doesn't know, and its unknown fields", () => {
    const index = parseIndex({
      stamp: 5,
      full: true,
      entries: [entry("a", { type: "ace-widget", rating: 5 })],
    });
    expect(index.entries[0]).toMatchObject({ type: "ace-widget", name: "a", extra: { rating: 5 } });
  });

  it("drops an unusable display value and falls back to the name", () => {
    const index = parseIndex({
      stamp: 5,
      full: true,
      entries: [
        entry("a", {
          title: 42,
          categories: ["Bad Category", "mail"],
          version: "latest",
          downloads: -1,
        }),
      ],
    });
    expect(index.entries[0]).toMatchObject({ title: "a", categories: ["mail"], downloads: 0 });
    expect(index.entries[0]?.version).toBeUndefined();
  });

  it("leaves out an entry with no usable name, and says so", () => {
    const index = parseIndex({ stamp: 5, full: true, entries: [entry("../x"), entry("b")] });
    expect(index.entries.map((item) => item.name)).toEqual(["b"]);
    expect(index.problems).toHaveLength(1);
  });

  it("refuses an index that lists one entry twice", () => {
    expect(() => parseIndex({ stamp: 5, full: true, entries: [entry("a"), entry("a")] })).toThrow(
      /twice/,
    );
  });

  it("merges a since answer into the cached listing: changes replace, removals go", () => {
    const cached = parseIndex({
      stamp: 5,
      full: true,
      entries: [entry("a"), entry("b"), entry("c")],
    }).entries;
    const delta = parseIndex({
      stamp: 9,
      full: false,
      entries: [entry("b", { title: "Better" }), entry("d")],
      removed: [{ type: "spade-skill", name: "c" }],
    });
    const merged = mergeIndex(cached, delta);
    expect(merged.map((item) => [item.name, item.title])).toEqual([
      ["a", "A"],
      ["b", "Better"],
      ["d", "D"],
    ]);
  });

  it("is replaced whole by a full answer", () => {
    const cached = parseIndex({ stamp: 5, full: true, entries: [entry("a")] }).entries;
    expect(
      mergeIndex(cached, parseIndex({ stamp: 9, full: true, entries: [entry("z")] })).map(
        (e) => e.name,
      ),
    ).toEqual(["z"]);
  });
});

describe("a git catalog", () => {
  it("reads a plugins-only catalog as before, each a spade-plugin", () => {
    const catalog = parseCatalog({
      name: "team",
      plugins: [{ name: "lint", source: "./plugins/lint", description: "Lints." }],
    });
    expect(catalog.entries).toEqual([
      expect.objectContaining({
        type: "spade-plugin",
        name: "lint",
        source: "plugins/lint",
        title: "lint",
        description: "Lints.",
      }),
    ]);
  });

  it("reads typed entries beside plugins, keeping types it doesn't know", () => {
    const catalog = parseCatalog({
      plugins: [],
      entries: [
        { type: "suit", name: "harbour", source: "suits/harbour", title: "Harbour" },
        { type: "ace-widget", name: "w", source: "." },
      ],
    });
    expect(catalog.entries.map((item) => [item.type, item.name, item.source])).toEqual([
      ["suit", "harbour", "suits/harbour"],
      ["ace-widget", "w", "."],
    ]);
  });

  it("leaves out an entry whose folder escapes the repository", () => {
    const catalog = parseCatalog({ entries: [{ type: "suit", name: "x", source: "../x" }] });
    expect(catalog.entries).toEqual([]);
    expect(catalog.problems).toHaveLength(1);
  });

  it("refuses a name listed twice across plugins and entries", () => {
    expect(() =>
      parseCatalog({
        plugins: [{ name: "lint", source: "a" }],
        entries: [{ type: "spade-plugin", name: "lint", source: "b" }],
      }),
    ).toThrow(/twice/);
  });
});
