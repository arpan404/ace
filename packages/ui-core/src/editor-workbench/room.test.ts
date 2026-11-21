import { describe, expect, it } from "vitest";
import { groupsFit, roomNeeded } from "./index.ts";
import { column, group, row } from "./layout.fixture.ts";

const one = group("g1", ["a.ts"]);
const two = row([group("g1", ["a.ts"]), group("g2", ["a.ts"])]);
const three = row([group("g1", []), column([group("g2", []), group("g3", [])])]);

describe("room for groups", () => {
  it.each([
    ["one group", one, { width: 320, height: 160 }],
    ["two side by side", two, { width: 640, height: 160 }],
    ["one beside two stacked", three, { width: 640, height: 320 }],
  ] as const)("%s needs %j", (_name, node, room) => {
    expect(roomNeeded(node)).toEqual(room);
  });

  it.each([
    ["one group in any room", one, { width: 200, height: 100 }, true],
    ["two groups in 1044px (full view with the explorer docked)", two, { width: 1044, height: 700 }, true],
    ["two groups in exactly 640px", two, { width: 640, height: 700 }, true],
    ["two groups in 620px (a panel at 860 with the explorer docked)", two, { width: 620, height: 700 }, false],
    ["a stack in too short a box", three, { width: 900, height: 300 }, false],
    ["a box not measured yet", two, { width: 0, height: 0 }, true],
  ] as const)("%s fits: %s", (_name, node, box, fits) => {
    expect(groupsFit(node, box)).toBe(fits);
  });
});
