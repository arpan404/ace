import { describe, expect, it } from "vitest";
import {
  copyTab,
  dropFile,
  dropZone,
  focusedGroup,
  groupsOf,
  limits,
  moveActiveEditor,
  moveTab,
  stripIndex,
} from "./index.ts";
import { group, ids, layoutOf, row, strip, strips } from "./layout.fixture.ts";

const box = { width: 300, height: 600 };

describe("drop targets", () => {
  it.each([
    [{ x: 150, y: 300 }, "center"],
    [{ x: 20, y: 300 }, "left"],
    [{ x: 290, y: 300 }, "right"],
    [{ x: 150, y: 30 }, "up"],
    [{ x: 150, y: 590 }, "down"],
    [{ x: 99, y: 300 }, "left"],
    [{ x: 101, y: 300 }, "center"],
    [{ x: 10, y: 10 }, "up"],
  ] as const)("a pointer at %j over the group's editor targets %s", (point, zone) => {
    expect(dropZone(point, box)).toBe(zone);
  });

  it("a group with no room yet takes drops in the middle", () => {
    expect(dropZone({ x: 0, y: 0 }, { width: 0, height: 0 })).toBe("center");
  });

  const tabs = [
    { left: 0, width: 80 },
    { left: 80, width: 100 },
    { left: 180, width: 60 },
  ];
  it.each([
    [10, 0],
    [41, 1],
    [129, 1],
    [131, 2],
    [500, 3],
  ])("a pointer at x=%i over the strip inserts at %i", (x, index) => {
    expect(stripIndex(tabs, x)).toBe(index);
  });
});

const two = () =>
  layoutOf(row([group("g1", ["a.ts", "b.ts"]), group("g2", ["c.ts", "d.ts"])]), "g1");

describe("dragging tabs", () => {
  it("onto another strip inserts the tab at the drop position, kept and showing", () => {
    const layout = layoutOf(row([group("g1", ["~a.ts", "b.ts"]), group("g2", ["c.ts", "d.ts"])]));
    const next = moveTab(
      layout,
      { group: "g1", path: "a.ts" },
      { kind: "strip", group: "g2", index: 1 },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["b.ts"], g2: ["c.ts", "a.ts", "d.ts"] });
    expect(focusedGroup(next)).toMatchObject({ id: "g2", active: "a.ts" });
  });

  it("within its own strip reorders it", () => {
    const layout = layoutOf(group("g1", ["a.ts", "b.ts", "c.ts"]));
    const right = moveTab(
      layout,
      { group: "g1", path: "a.ts" },
      { kind: "strip", group: "g1", index: 3 },
      ids(),
    );
    expect(strip(right, "g1")).toEqual(["b.ts", "c.ts", "a.ts"]);
    const left = moveTab(
      layout,
      { group: "g1", path: "c.ts" },
      { kind: "strip", group: "g1", index: 0 },
      ids(),
    );
    expect(strip(left, "g1")).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("an unpinned tab dropped among pinned tabs lands after them", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["^p.ts", "^q.ts", "c.ts"])]));
    const next = moveTab(
      layout,
      { group: "g1", path: "a.ts" },
      { kind: "strip", group: "g2", index: 0 },
      ids(),
    );
    expect(strip(next, "g2")).toEqual(["^p.ts", "^q.ts", "a.ts", "c.ts"]);
  });

  it("onto the middle of another group's editor moves it into that group", () => {
    const next = moveTab(
      two(),
      { group: "g1", path: "a.ts" },
      { kind: "group", group: "g2" },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["b.ts"], g2: ["c.ts", "a.ts", "d.ts"] });
  });

  it("onto an outer third makes a new group on that side", () => {
    const next = moveTab(
      two(),
      { group: "g1", path: "b.ts" },
      { kind: "side", group: "g2", side: "right" },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["a.ts"], g2: ["c.ts", "d.ts"], n1: ["b.ts"] });
    expect(next.focused).toBe("n1");
  });

  it("onto an outer third of its own group splits it", () => {
    const next = moveTab(
      two(),
      { group: "g1", path: "b.ts" },
      { kind: "side", group: "g1", side: "down" },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["a.ts"], n1: ["b.ts"], g2: ["c.ts", "d.ts"] });
  });

  it("a group's only tab dropped on its own outer third stays where it is", () => {
    const layout = layoutOf(group("g1", ["a.ts"]));
    expect(
      moveTab(
        layout,
        { group: "g1", path: "a.ts" },
        { kind: "side", group: "g1", side: "right" },
        ids(),
      ),
    ).toBe(layout);
  });

  it("onto an outer third with the most groups there can be moves it into that group", () => {
    const groups = Array.from({ length: limits.groups }, (_, i) =>
      group(`g${i + 1}`, [`f${i}.ts`, "x.ts"]),
    );
    const layout = layoutOf(row(groups));
    const next = moveTab(
      layout,
      { group: "g1", path: "f0.ts" },
      { kind: "side", group: "g2", side: "down" },
      ids(),
    );
    expect(groupsOf(next)).toHaveLength(limits.groups);
    expect(strip(next, "g2")).toContain("f0.ts");
  });

  it("a group emptied by a drag closes", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["c.ts"])]));
    const next = moveTab(
      layout,
      { group: "g1", path: "a.ts" },
      { kind: "group", group: "g2" },
      ids(),
    );
    expect(strips(next)).toEqual({ g2: ["c.ts", "a.ts"] });
    expect(next.root.kind).toBe("group");
  });

  it("onto a group that already shows the file joins the two views", () => {
    const layout = layoutOf(
      row([group("g1", ["a.ts", "b.ts"]), group("g2", ["a.ts", "c.ts"], "c.ts")]),
    );
    const next = moveTab(
      layout,
      { group: "g1", path: "a.ts" },
      { kind: "group", group: "g2" },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["b.ts"], g2: ["a.ts", "c.ts"] });
    expect(focusedGroup(next).active).toBe("a.ts");
  });

  it("⌥-drag opens a second view and leaves the original", () => {
    const next = copyTab(
      two(),
      { group: "g1", path: "a.ts" },
      { kind: "strip", group: "g2", index: 0 },
      ids(),
    );
    expect(strips(next)).toEqual({ g1: ["a.ts", "b.ts"], g2: ["a.ts", "c.ts", "d.ts"] });
  });

  it("⌥-drag within its own strip changes nothing", () => {
    const layout = two();
    expect(
      copyTab(
        layout,
        { group: "g1", path: "a.ts" },
        { kind: "strip", group: "g1", index: 2 },
        ids(),
      ),
    ).toBe(layout);
  });

  it("a file dragged from the explorer onto a group opens there, kept", () => {
    const next = dropFile(two(), "new.ts", { kind: "side", group: "g2", side: "down" }, ids());
    expect(strips(next)).toEqual({ g1: ["a.ts", "b.ts"], g2: ["c.ts", "d.ts"], n1: ["new.ts"] });
  });

  it("a dropped file already open as the preview there is kept", () => {
    const layout = layoutOf(group("g1", ["a.ts", "~b.ts"]));
    expect(strip(dropFile(layout, "b.ts", { kind: "group", group: "g1" }, ids()), "g1")).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});

describe("moving the active editor between groups", () => {
  it("⌃⌘→ moves it to the next group and ⌃⌘← back", () => {
    const layout = layoutOf(row([group("g1", ["a.ts", "b.ts"]), group("g2", ["c.ts"])]), "g1");
    const next = moveActiveEditor(layout, "next", ids());
    expect(strips(next)).toEqual({ g1: ["b.ts"], g2: ["c.ts", "a.ts"] });
    expect(next.focused).toBe("g2");
    const back = moveActiveEditor(next, "previous", ids());
    expect(strips(back)).toEqual({ g1: ["b.ts", "a.ts"], g2: ["c.ts"] });
  });

  it("⌃⌘→ from the last group opens a new group to the right", () => {
    const layout = layoutOf(group("g1", ["a.ts", "b.ts"]));
    expect(strips(moveActiveEditor(layout, "next", ids()))).toEqual({ g1: ["b.ts"], n1: ["a.ts"] });
  });

  it.each([
    ["⌃⌘← from the first group", group("g1", ["a.ts", "b.ts"]), "previous"],
    ["⌃⌘→ with the group's only editor", group("g1", ["a.ts"]), "next"],
    ["either way in an empty group", group("g1", []), "next"],
  ] as const)("%s changes nothing", (_name, root, toward) => {
    const layout = layoutOf(root);
    expect(moveActiveEditor(layout, toward, ids())).toBe(layout);
  });
});
