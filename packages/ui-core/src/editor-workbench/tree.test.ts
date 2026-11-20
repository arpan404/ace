import { describe, expect, it } from "vitest";
import {
  adjacentGroup,
  emptyLayout,
  evenSplit,
  focusGroupAt,
  focusedGroup,
  groupsOf,
  limits,
  removeGroup,
  resizeSplit,
  splitGroup,
  type EditorLayout,
} from "./index.ts";
import { column, group, ids, layoutOf, row, strips } from "./layout.fixture.ts";

const walk = (node: EditorLayout["root"]): unknown =>
  node.kind === "group"
    ? node.id
    : { [node.direction]: node.children.map(walk), sizes: node.sizes };
const shape = (layout: EditorLayout): unknown => walk(layout.root);

describe("splits", () => {
  it("split right puts a second view of the focused editor in a new group beside it, focused", () => {
    const layout = layoutOf(group("g1", ["a.ts", "~b.ts"], "b.ts"));
    const next = splitGroup(layout, "g1", "right", ids());
    expect(strips(next)).toEqual({ g1: ["a.ts", "~b.ts"], n1: ["b.ts"] });
    expect(shape(next)).toEqual({ row: ["g1", "n1"], sizes: [0.5, 0.5] });
    expect(next.focused).toBe("n1");
  });

  it("split down under a group in a row makes a column in its place", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g2");
    const next = splitGroup(layout, "g2", "down", ids());
    expect(shape(next)).toEqual({
      row: ["g1", { column: ["g2", "n1"], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
  });

  it("splitting along the split's own direction adds a sibling that halves the group's room", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])], [0.6, 0.4]));
    const next = splitGroup(layout, "g1", "left", ids());
    expect(shape(next)).toEqual({ row: ["n1", "g1", "g2"], sizes: [0.3, 0.3, 0.4] });
  });

  it("splitting an empty group makes an empty group", () => {
    const next = splitGroup(emptyLayout("g1"), "g1", "right", ids());
    expect(strips(next)).toEqual({ g1: [], n1: [] });
  });

  it(`holds at most ${limits.groups} groups`, () => {
    let layout = layoutOf(group("g1", ["a.ts"]));
    const next = ids();
    for (let i = 0; i < limits.groups + 3; i += 1) {
      layout = splitGroup(layout, layout.focused, i % 2 ? "right" : "down", next);
    }
    expect(groupsOf(layout)).toHaveLength(limits.groups);
  });

  it("removing a group collapses a split of one and flattens a split into its own direction", () => {
    const layout = layoutOf(
      row([group("g1", []), column([group("g2", []), row([group("g3", []), group("g4", [])])])]),
    );
    const next = removeGroup(layout, "g2");
    expect(shape(next)).toEqual({ row: ["g1", "g3", "g4"], sizes: [0.5, 0.25, 0.25] });
  });

  it("removing the only group changes nothing", () => {
    const layout = emptyLayout("g1");
    expect(removeGroup(layout, "g1")).toBe(layout);
  });
});

describe("resizing", () => {
  const layout = layoutOf(
    row([group("g1", []), group("g2", []), group("g3", [])], [0.5, 0.25, 0.25]),
  );

  it("dragging an edge sets the split's fractions", () => {
    expect(shape(resizeSplit(layout, [], [2, 1, 1]))).toMatchObject({ sizes: [0.5, 0.25, 0.25] });
    expect(shape(resizeSplit(layout, [], [0.2, 0.4, 0.4]))).toMatchObject({
      sizes: [0.2, 0.4, 0.4],
    });
  });

  it("a group dragged to nothing keeps a sliver", () => {
    const root = resizeSplit(layout, [], [0, 0.5, 0.5]).root;
    const sizes = root.kind === "split" ? root.sizes : [];
    expect(sizes[0]).toBeGreaterThan(0.04);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it.each([
    ["the wrong number of sizes", [], [0.5, 0.5]],
    ["a negative size", [], [-1, 1, 1]],
    ["a path to a group", [0], [1]],
  ])("ignores %s", (_name, at, sizes) => {
    expect(resizeSplit(layout, at, sizes)).toBe(layout);
  });

  it("double-clicking an edge evens the split", () => {
    const even = evenSplit(layout, []);
    expect(shape(even)).toMatchObject({ sizes: [1 / 3, 1 / 3, 1 / 3] });
    expect(evenSplit(even, [])).toBe(even);
  });
});

describe("group focus", () => {
  const layout = layoutOf(
    row([group("g1", []), column([group("g2", []), group("g3", [])]), group("g4", [])]),
    "g1",
  );

  it.each([
    [1, "g1"],
    [2, "g2"],
    [3, "g3"],
    [4, "g4"],
  ])("⌘%i focuses group %s in reading order", (ordinal, id) => {
    expect(focusedGroup(focusGroupAt(layout, ordinal)).id).toBe(id);
  });

  it("⌘ past the last group changes nothing", () => {
    expect(focusGroupAt(layout, 7)).toBe(layout);
  });

  it.each([
    ["g1", "right", "g2"],
    ["g3", "right", "g4"],
    ["g4", "left", "g2"],
    ["g2", "down", "g3"],
    ["g3", "up", "g2"],
    ["g1", "left", undefined],
    ["g1", "down", undefined],
  ] as const)("the group %s of %s is %s", (from, side, expected) => {
    expect(adjacentGroup(layout, from, side)?.id).toBe(expected);
  });
});
