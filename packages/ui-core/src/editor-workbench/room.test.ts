import { describe, expect, it } from "vitest";
import { displayPanes, groupsFit, roomNeeded, splitSide, type SplitNode } from "./index.ts";
import { column, group, layoutOf, row } from "./layout.fixture.ts";

const one = group("g1", ["a.ts"]);
const two = row([group("g1", ["a.ts"]), group("g2", ["a.ts"])]);
const three = row([group("g1", []), column([group("g2", []), group("g3", [])])]);
const four = row(["g1", "g2", "g3", "g4"].map((id) => group(id, ["a.ts"])));

/** The display tree's directions, in reading order, for comparing shapes. */
function shape(node: SplitNode): unknown {
  return node.kind === "group" ? node.id : { [node.direction]: node.children.map(shape) };
}

describe("room for panes", () => {
  it.each([
    ["one pane", one, { width: 420, height: 160 }],
    ["two side by side", two, { width: 840, height: 160 }],
    ["one beside two stacked", three, { width: 840, height: 320 }],
  ] as const)("%s needs %j at the roomy minimum", (_name, node, room) => {
    expect(roomNeeded(node)).toEqual(room);
  });

  it("a smaller pane minimum needs less", () => {
    expect(roomNeeded(two, { width: 280, height: 160 })).toEqual({ width: 560, height: 160 });
  });

  it.each([
    ["one pane in any room", one, { width: 200, height: 100 }, true],
    ["two panes in exactly 840px", two, { width: 840, height: 700 }, true],
    ["two panes in a 640px panel", two, { width: 640, height: 700 }, false],
    ["a box not measured yet", two, { width: 0, height: 0 }, true],
  ] as const)("%s fits at the roomy minimum: %s", (_name, node, box, fits) => {
    expect(groupsFit(node, box)).toBe(fits);
  });
});

describe("panes on screen", () => {
  it.each([
    [
      "two panes with room sit side by side at 420px",
      two,
      { width: 900, height: 700 },
      { row: ["g1", "g2"] },
      420,
    ],
    [
      "two panes in 640px sit side by side at 280px",
      two,
      { width: 640, height: 700 },
      { row: ["g1", "g2"] },
      280,
    ],
    ["two panes in 500px stack", two, { width: 500, height: 700 }, { column: ["g1", "g2"] }, 0],
    [
      "four panes in 640px stack",
      four,
      { width: 640, height: 900 },
      { column: ["g1", "g2", "g3", "g4"] },
      0,
    ],
    [
      "a pane beside a stack, without room, stacks whole",
      three,
      { width: 400, height: 700 },
      { column: ["g1", { column: ["g2", "g3"] }] },
      0,
    ],
    ["one pane is itself", one, { width: 200, height: 100 }, "g1", 420],
  ] as const)("%s", (_name, node, box, drawn, paneWidth) => {
    const shown = displayPanes(node, box);
    expect(shape(shown.root)).toEqual(drawn);
    expect(shown.pane.width).toBe(paneWidth);
  });

  it("stacking for display keeps the stored sizes, so resizing maps onto the stored split", () => {
    const uneven = row([group("g1", []), group("g2", [])], [0.7, 0.3]);
    const shown = displayPanes(uneven, { width: 400, height: 700 });
    expect(shown.root.kind === "split" && shown.root.sizes).toEqual([0.7, 0.3]);
  });

  it("never hides a pane, even with no room at all", () => {
    const shown = displayPanes(four, { width: 200, height: 200 });
    expect(shape(shown.root)).toEqual({ column: ["g1", "g2", "g3", "g4"] });
    expect(shown.pane).toEqual({ width: 0, height: 0 });
  });
});

describe("where a new pane goes", () => {
  it.each([
    ["a right split with room stays right", one, "right", { width: 900, height: 700 }, "right"],
    [
      "a right split that fits at 280px stays right",
      one,
      "right",
      { width: 600, height: 700 },
      "right",
    ],
    ["a right split without 560px goes down", one, "right", { width: 500, height: 700 }, "down"],
    ["a left split without room goes up", one, "left", { width: 500, height: 700 }, "up"],
    ["a down split stays down", one, "down", { width: 300, height: 700 }, "down"],
    [
      "a third pane beside two in 800px goes down",
      two,
      "right",
      { width: 800, height: 700 },
      "down",
    ],
    [
      "a third pane beside two in 900px stays right",
      two,
      "right",
      { width: 900, height: 700 },
      "right",
    ],
  ] as const)("%s", (_name, node, side, room, placed) => {
    expect(splitSide(layoutOf(node), "g1", side, room)).toBe(placed);
  });
});
