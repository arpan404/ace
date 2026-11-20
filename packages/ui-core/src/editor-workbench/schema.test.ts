import { describe, expect, it } from "vitest";
import {
  defaultExplorer,
  discardTabs,
  emptyLayout,
  groupsOf,
  limits,
  openEditor,
  parseLayout,
  splitGroup,
  storedLayout,
  type EditorLayout,
} from "./index.ts";
import { column, group, ids, layoutOf, row, strip, strips } from "./layout.fixture.ts";

const reload = (layout: unknown) => parseLayout(JSON.parse(JSON.stringify(layout)), "fresh");

describe("reading a stored layout", () => {
  it("a layout comes back from storage as it was saved", () => {
    let layout = layoutOf(
      row(
        [
          group("g1", ["^p.ts", "a.ts", "~b.ts"], "a.ts"),
          column([group("g2", ["c.ts"]), group("g3", [])]),
        ],
        [0.6, 0.4],
      ),
      "g2",
    );
    layout = {
      ...layout,
      explorer: {
        ...defaultExplorer,
        side: "search",
        query: "relay",
        expanded: ["src"],
        scroll: 120,
      },
    };
    layout = discardTabs(
      openEditor(layout, "x.ts", { intent: "keep", view: { anchor: { line: 3, offset: 0 } } }),
      [{ group: "g2", path: "x.ts" }],
    );
    expect(reload(layout)).toEqual(layout);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "{not json"],
    ["a number", 42],
    ["an empty object", {}],
    ["a root that isn't a node", { root: "group" }],
    [
      "a split with no children",
      { root: { kind: "split", direction: "row", sizes: [], children: [] } },
    ],
    ["a group with no id", { root: { kind: "group", tabs: [] } }],
    ["an unknown node kind", { root: { kind: "grid", cells: [] } }],
  ])("a corrupt layout (%s) parses to one empty group", (_name, raw) => {
    const layout = parseLayout(raw, "fresh");
    expect(layout).toEqual(emptyLayout("fresh"));
  });

  it("fields this build doesn't know are kept at every level", () => {
    const raw = {
      version: 7,
      root: {
        kind: "split",
        direction: "row",
        sizes: [0.5, 0.5],
        weight: "heavy",
        children: [
          {
            kind: "group",
            id: "g1",
            tabs: [
              {
                path: "a.ts",
                preview: false,
                pinned: false,
                colour: "red",
                view: { anchor: { line: 1, offset: 0 }, wrap: true },
              },
            ],
            active: "a.ts",
            mru: ["a.ts"],
            locked: true,
          },
          { kind: "group", id: "g2", tabs: [], mru: [] },
        ],
      },
      focused: "g1",
      explorer: { ...defaultExplorer, sort: "kind" },
      closed: [
        { group: "g1", index: 0, tab: { path: "z.ts", preview: false, pinned: false }, at: 5 },
      ],
    };
    const layout = parseLayout(raw, "fresh");
    expect(layout).toMatchObject({
      version: 7,
      root: {
        weight: "heavy",
        children: [{ locked: true, tabs: [{ colour: "red", view: { wrap: true } }] }, {}],
      },
      explorer: { sort: "kind" },
      closed: [{ at: 5 }],
    });
    // Operations keep them too.
    const split = splitGroup(layout, "g2", "down", ids());
    expect(split).toMatchObject({ version: 7, root: { weight: "heavy" } });
    expect(groupsOf(split)[0]).toMatchObject({ locked: true });
  });

  it("a bad tab drops alone, and a path appears once per group", () => {
    const layout = parseLayout(
      {
        root: {
          kind: "group",
          id: "g1",
          tabs: [
            { path: "a.ts" },
            { path: "" },
            7,
            { name: "x" },
            { path: "a.ts", pinned: true },
            { path: "b.ts", preview: "yes" },
          ],
          mru: [],
        },
      },
      "fresh",
    );
    expect(strip(layout, "g1")).toEqual(["a.ts", "b.ts"]);
  });

  it("pinned tabs come first and a group keeps one preview, never a pinned one", () => {
    const layout = parseLayout(
      {
        root: {
          kind: "group",
          id: "g1",
          tabs: [
            { path: "a.ts", preview: true },
            { path: "p.ts", pinned: true, preview: true },
            { path: "b.ts", preview: true },
          ],
          mru: [],
        },
      },
      "fresh",
    );
    expect(strip(layout, "g1")).toEqual(["^p.ts", "~a.ts", "b.ts"]);
  });

  it("an active tab or MRU entry that isn't open falls back to an open one", () => {
    const layout = parseLayout(
      {
        root: {
          kind: "group",
          id: "g1",
          tabs: [{ path: "a.ts" }, { path: "b.ts" }],
          active: "gone.ts",
          mru: ["gone.ts", "b.ts", 3],
        },
      },
      "fresh",
    );
    expect(groupsOf(layout)[0]).toMatchObject({ active: "b.ts", mru: ["b.ts", "a.ts"] });
  });

  it("a focus on a group that isn't there falls to the first group", () => {
    const layout = parseLayout({ root: group("g1", []), focused: "g9" }, "fresh");
    expect(layout.focused).toBe("g1");
  });

  it("a repeated group id keeps the first group", () => {
    const layout = parseLayout(
      { root: row([group("g1", ["a.ts"]), group("g1", ["b.ts"])]) },
      "fresh",
    );
    expect(strips(layout)).toEqual({ g1: ["a.ts"] });
    expect(layout.root.kind).toBe("group");
  });

  it(`keeps at most ${limits.groups} groups`, () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`g${i}`, []));
    expect(groupsOf(parseLayout({ root: row(groups) }, "fresh"))).toHaveLength(limits.groups);
  });

  it("a split's unusable sizes become even, and a split of one gives way to its child", () => {
    const even = parseLayout(
      { root: { ...row([group("g1", []), group("g2", [])]), sizes: [1, "x"] } },
      "fresh",
    );
    expect(even.root).toMatchObject({ sizes: [0.5, 0.5] });
    const one = parseLayout(
      {
        root: {
          kind: "split",
          direction: "row",
          children: [group("g1", ["a.ts"]), { kind: "group" }],
        },
      },
      "fresh",
    );
    expect(one.root).toMatchObject({ kind: "group", id: "g1" });
  });

  it("an explorer field out of range takes its default, the rest stay", () => {
    const layout = parseLayout(
      { root: group("g1", []), explorer: { width: 9000, side: "search", scroll: -4 } },
      "fresh",
    );
    expect(layout.explorer).toMatchObject({
      width: defaultExplorer.width,
      side: "search",
      scroll: 0,
    });
  });

  it(`keeps the last ${limits.closed} closed editors and drops bad ones`, () => {
    const closed = [
      { group: "g1", tab: { path: "" } },
      ...Array.from({ length: 30 }, (_, i) => ({
        group: "g1",
        index: i,
        tab: { path: `f${i}.ts` },
      })),
    ];
    const layout = parseLayout({ root: group("g1", []), closed }, "fresh");
    expect(layout.closed).toHaveLength(limits.closed);
    expect(layout.closed[0]?.tab.path).toBe("f0.ts");
  });

  it("a deeply nested tree beyond any made by hand is not followed", () => {
    let node: unknown = group("deep", ["a.ts"]);
    for (let i = 0; i < 40; i += 1)
      node = {
        kind: "split",
        direction: i % 2 ? "row" : "column",
        sizes: [0.5, 0.5],
        children: [node, group(`s${i}`, [])],
      };
    const layout = parseLayout({ root: node }, "fresh");
    expect(groupsOf(layout).some((each) => each.id === "deep")).toBe(false);
  });
});

/** `count` tabs in one group; f0 is the most recently used, the last file the least. */
const many = (count: number, pinned?: string) => {
  const paths = Array.from({ length: count }, (_, i) => `f${i}.ts`);
  const marks = paths.map((path) => (path === pinned ? `^${path}` : path));
  // f0 is the most recently used, the last file the least.
  return layoutOf(
    group(
      "g1",
      [...marks.filter((m) => m.startsWith("^")), ...marks.filter((m) => !m.startsWith("^"))],
      "f0.ts",
    ),
  );
};

describe("storing a layout", () => {
  it(`under ${limits.storedTabs} tabs stores the layout as it is`, () => {
    const layout = many(limits.storedTabs);
    expect(storedLayout(layout, new Set())).toBe(layout);
  });

  it("past the cap the least recently used tabs drop", () => {
    const stored = storedLayout(many(limits.storedTabs + 3), new Set());
    const paths = strip(stored, "g1") ?? [];
    expect(paths).toHaveLength(limits.storedTabs);
    expect(paths).not.toContain(`f${limits.storedTabs + 2}.ts`);
    expect(paths).toContain("f0.ts");
  });

  it("past the cap, pinned and unsaved tabs never drop", () => {
    const last = `f${limits.storedTabs}.ts`;
    const pinnedLast = storedLayout(many(limits.storedTabs + 1, last), new Set());
    expect(strip(pinnedLast, "g1")).toContain(`^${last}`);
    const unsavedLast = storedLayout(many(limits.storedTabs + 1), new Set([last]));
    expect(strip(unsavedLast, "g1")).toContain(last);
    expect(strip(unsavedLast, "g1")).toHaveLength(limits.storedTabs);
  });

  it("a stored layout reads back the same", () => {
    const layout: EditorLayout = layoutOf(
      row([group("g1", ["a.ts", "~b.ts"]), group("g2", ["^c.ts"])]),
      "g2",
    );
    expect(reload(storedLayout(layout, new Set()))).toEqual(layout);
  });
});
