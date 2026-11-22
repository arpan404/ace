import { describe, expect, it, test } from "vitest";
import {
  blockAt,
  blockWords,
  landBlocks,
  mapBlocks,
  projectBlocks,
  withoutLines,
  type AgentBlock,
} from "./agent-lines.ts";

const claude = { name: "Claude Code", provider: "claude", turn: 2 } as const;
const block = (start: number, end: number): AgentBlock => ({ start, end, who: claude, at: 1 });
const span = (each: AgentBlock) => [each.start, each.end];

test("an agent's change becomes a block of the lines it wrote, in the new text's lines", () => {
  // Line 1 became two lines; lines 5–6 were removed.
  const landed = landBlocks(
    [],
    [
      { start: 1, end: 2, text: "a\nb\n" },
      { start: 5, end: 7, text: "" },
    ],
    claude,
    1,
  );
  expect(landed.map(span)).toEqual([
    [1, 3],
    [6, 6],
  ]);
});

test.each([
  {
    name: "lines typed above move a block down",
    change: { start: 0, end: 0, text: "x\ny\n" },
    after: [[5, 7]],
  },
  {
    name: "lines removed above move it up",
    change: { start: 0, end: 2, text: "" },
    after: [[1, 3]],
  },
  {
    name: "a change below leaves it where it is",
    change: { start: 9, end: 10, text: "z\n" },
    after: [[3, 5]],
  },
  {
    name: "a line typed right above it pushes it down",
    change: { start: 3, end: 3, text: "x\n" },
    after: [[4, 6]],
  },
  {
    name: "a line added right after it leaves it",
    change: { start: 5, end: 5, text: "x\n" },
    after: [[3, 5]],
  },
  {
    name: "the person typing in it makes it theirs",
    change: { start: 4, end: 5, text: "edit\n" },
    after: [],
  },
  {
    name: "a line added inside it makes it theirs",
    change: { start: 4, end: 4, text: "x\n" },
    after: [],
  },
])("$name", ({ change, after }) => {
  expect(mapBlocks([block(3, 5)], [change]).map(span)).toEqual(after);
});

test("a later agent change over an earlier block replaces it with the new one", () => {
  const first = landBlocks([], [{ start: 2, end: 3, text: "v1\n" }], claude, 1);
  const second = landBlocks(first, [{ start: 2, end: 3, text: "v2\nv2b\n" }], claude, 2);
  expect(second.map((each) => [each.start, each.end, each.at])).toEqual([[2, 4, 2]]);
});

test("a removal's block is found on the line below the gap", () => {
  const blocks = [block(2, 2), block(5, 7)];
  expect(blockAt(blocks, 2)).toBe(blocks[0]);
  expect(blockAt(blocks, 6)).toBe(blocks[1]);
  expect(blockAt(blocks, 3)).toBeUndefined();
});

test("keeping lines drops only the blocks over them", () => {
  expect(withoutLines([block(1, 3), block(6, 8), block(10, 10)], 6, 8).map(span)).toEqual([
    [1, 3],
    [10, 10],
  ]);
});

test("the hover names the agent and the turn, or only the agent", () => {
  expect(blockWords(claude)).toBe("Claude Code changed this in turn 2");
  expect(blockWords({ name: "Fix relay loop" })).toBe("Fix relay loop changed this");
});

describe("the agent's lines as the text is now", () => {
  const blocks = [block(2, 5)];

  it("are all still the agent's while nothing touched them", () => {
    expect(projectBlocks(blocks, []).map(span)).toEqual([[2, 5]]);
  });

  it("lose only the line the person edited", () => {
    expect(projectBlocks(blocks, [{ start: 3, end: 4, text: "edited\n" }]).map(span)).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  it("move with lines added above and split around lines added inside", () => {
    expect(
      projectBlocks(blocks, [
        { start: 0, end: 0, text: "x\n" },
        { start: 4, end: 4, text: "y\nz\n" },
      ]).map(span),
    ).toEqual([
      [3, 5],
      [7, 8],
    ]);
  });

  it("keep their author on every piece", () => {
    const [first, second] = projectBlocks(blocks, [{ start: 3, end: 4, text: "edited\n" }]);
    expect([first?.who, second?.who]).toEqual([claude, claude]);
  });
});
