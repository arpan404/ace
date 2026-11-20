import { describe, expect, it } from "vitest";
import {
  closeTabs,
  discardTabs,
  focusedGroup,
  groupsOf,
  limits,
  reopenClosed,
  setViewState,
  tabsToClose,
  type CloseWhich,
} from "./index.ts";
import { group, layoutOf, row, strip, strips } from "./layout.fixture.ts";

const none: ReadonlySet<string> = new Set();
const ref = (path: string, id = "g1") => ({ group: id, path });

describe("close variants", () => {
  const layout = layoutOf(group("g1", ["^p.ts", "^q.ts", "a.ts", "b.ts", "c.ts", "d.ts"], "b.ts"));
  const unsaved = new Set(["c.ts"]);

  it.each<[CloseWhich, string[]]>([
    ["others", ["a.ts", "c.ts", "d.ts"]],
    ["right", ["c.ts", "d.ts"]],
    ["saved", ["a.ts", "b.ts", "d.ts"]],
    ["all", ["p.ts", "q.ts", "a.ts", "b.ts", "c.ts", "d.ts"]],
  ])(
    "close %s around b.ts closes %j, keeping pinned tabs unless it is close all",
    (which, paths) => {
      expect(tabsToClose(layout, ref("b.ts"), which, unsaved).map((each) => each.path)).toEqual(
        paths,
      );
    },
  );

  it("close to the right of a pinned tab still keeps the other pinned tabs", () => {
    expect(tabsToClose(layout, ref("p.ts"), "right", none).map((each) => each.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
    ]);
  });
});

describe("unsaved files never close silently", () => {
  it("closing the last view of an unsaved file asks instead", () => {
    const layout = layoutOf(group("g1", ["a.ts", "b.ts"]));
    const result = closeTabs(layout, [ref("a.ts"), ref("b.ts")], new Set(["a.ts"]));
    expect(result.asking).toEqual([ref("a.ts")]);
    expect(strip(result.layout, "g1")).toEqual(["a.ts"]);
  });

  it("closing one of two views of an unsaved file closes it: the other still holds the edits", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["a.ts", "b.ts"])]));
    const result = closeTabs(layout, [ref("a.ts", "g2")], new Set(["a.ts"]));
    expect(result.asking).toEqual([]);
    expect(strips(result.layout)).toEqual({ g1: ["a.ts"], g2: ["b.ts"] });
  });

  it("closing every view of an unsaved file at once asks about each", () => {
    const layout = layoutOf(row([group("g1", ["a.ts", "x.ts"]), group("g2", ["a.ts", "y.ts"])]));
    const result = closeTabs(layout, [ref("a.ts"), ref("a.ts", "g2")], new Set(["a.ts"]));
    expect(result.asking).toEqual([ref("a.ts"), ref("a.ts", "g2")]);
  });

  it("after the person answers, the asked-about tabs close", () => {
    const layout = layoutOf(group("g1", ["a.ts", "b.ts"]));
    expect(strip(discardTabs(layout, [ref("a.ts")]), "g1")).toEqual(["b.ts"]);
  });
});

describe("closing tabs and groups", () => {
  it("closing the showing tab shows the most recently used one", () => {
    const layout = layoutOf({
      ...group("g1", ["a.ts", "b.ts", "c.ts"]),
      active: "a.ts",
      mru: ["a.ts", "c.ts", "b.ts"],
    });
    expect(focusedGroup(discardTabs(layout, [ref("a.ts")])).active).toBe("c.ts");
  });

  it("a group whose last tab closes disappears and its neighbour takes its room", () => {
    const layout = layoutOf(
      row([group("g1", ["a.ts"]), group("g2", ["b.ts"]), group("g3", ["c.ts"])], [0.2, 0.3, 0.5]),
      "g2",
    );
    const next = discardTabs(layout, [ref("b.ts", "g2")]);
    expect(groupsOf(next).map((each) => each.id)).toEqual(["g1", "g3"]);
    expect(next.root.kind === "split" && next.root.sizes).toEqual([0.5, 0.5]);
    expect(next.focused).toBe("g1");
  });

  it("a split left with one group gives way to it", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]));
    const next = discardTabs(layout, [ref("b.ts", "g2")]);
    expect(next.root).toMatchObject({ kind: "group", id: "g1" });
  });

  it("the last group never closes; it stays, empty", () => {
    const layout = layoutOf(group("g1", ["a.ts"]));
    const next = discardTabs(layout, [ref("a.ts")]);
    expect(next.root).toMatchObject({ kind: "group", id: "g1", tabs: [], active: undefined });
  });
});

describe("reopen closed", () => {
  it("brings back the last closed editor in its group at its index, with its view state", () => {
    let layout = layoutOf(group("g1", ["a.ts", "b.ts", "c.ts"]));
    const view = { anchor: { line: 40, offset: 3 }, selections: [{ anchor: 10, head: 12 }] };
    layout = setViewState(layout, ref("b.ts"), view);
    layout = discardTabs(layout, [ref("b.ts")]);
    const back = reopenClosed(layout);
    expect(strip(back, "g1")).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(focusedGroup(back).active).toBe("b.ts");
    expect(focusedGroup(back).tabs[1]?.view).toEqual(view);
    expect(back.closed).toEqual([]);
  });

  it("reopens the most recently closed first", () => {
    let layout = layoutOf(group("g1", ["a.ts", "b.ts", "c.ts"]));
    layout = discardTabs(layout, [ref("a.ts")]);
    layout = discardTabs(layout, [ref("c.ts")]);
    expect(focusedGroup(reopenClosed(layout)).active).toBe("c.ts");
  });

  it("an editor whose group has gone reopens in the focused group", () => {
    let layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g1");
    layout = discardTabs(layout, [ref("b.ts", "g2")]);
    expect(strips(reopenClosed(layout))).toEqual({ g1: ["a.ts", "b.ts"] });
  });

  it("an editor that is open again comes forward instead of opening twice", () => {
    let layout = layoutOf(group("g1", ["a.ts", "b.ts"]));
    layout = discardTabs(layout, [ref("a.ts")]);
    layout = { ...layout, root: group("g1", ["b.ts", "a.ts"], "b.ts") };
    const back = reopenClosed(layout);
    expect(strip(back, "g1")).toEqual(["b.ts", "a.ts"]);
    expect(focusedGroup(back).active).toBe("a.ts");
  });

  it("a closed preview comes back kept when its group already has a preview", () => {
    let layout = layoutOf(group("g1", ["~a.ts", "b.ts"]));
    layout = discardTabs(layout, [ref("a.ts")]);
    layout = { ...layout, root: group("g1", ["b.ts", "~c.ts"]) };
    expect(strip(reopenClosed(layout), "g1")).toEqual(["a.ts", "b.ts", "~c.ts"]);
  });

  it(`keeps the last ${limits.closed} closed editors`, () => {
    const paths = Array.from({ length: limits.closed + 5 }, (_, i) => `f${i}.ts`);
    let layout = layoutOf(group("g1", [...paths, "keep.ts"]));
    for (const path of paths) layout = discardTabs(layout, [ref(path)]);
    expect(layout.closed).toHaveLength(limits.closed);
    expect(layout.closed[0]?.tab.path).toBe(`f${paths.length - 1}.ts`);
  });

  it("with nothing closed, reopen changes nothing", () => {
    const layout = layoutOf(group("g1", ["a.ts"]));
    expect(reopenClosed(layout)).toBe(layout);
  });
});
