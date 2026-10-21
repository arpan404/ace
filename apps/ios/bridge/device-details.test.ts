import type { ScreenUINode } from "@ace/protocol";
import { expect, test } from "vitest";
import { appendLogs, logKeep, logView, treeRows } from "./device-details.ts";

test("the log tail keeps the newest lines, counts skipped ones and colours each by level", () => {
  let tail = { lines: [] as string[], dropped: 0 };
  const many = Array.from({ length: logKeep + 10 }, (_, index) => `line ${index}`);
  tail = appendLogs(tail, many, 3);
  tail = appendLogs(tail, ["W/Choreographer( 123): Skipped 30 frames"], 2);

  const shown = logView(tail, "");
  expect(shown.total).toBe(logKeep);
  expect(shown.dropped).toBe(5);
  expect(shown.lines.at(-1)).toEqual({
    text: "W/Choreographer( 123): Skipped 30 frames",
    level: "warning",
  });
});

test("the log filter keeps matching lines, ignoring case, and says how many matched", () => {
  const tail = appendLogs(
    { lines: [], dropped: 0 },
    ["Network up", "SpringBoard", "network <Error>"],
    0,
  );

  const shown = logView(tail, "NETWORK");
  expect(shown.matches).toBe(2);
  expect(shown.lines).toEqual([
    { text: "Network up", level: "info" },
    { text: "network <Error>", level: "error" },
  ]);
});

const node = (
  role: string,
  name: string,
  actions: ScreenUINode["actions"],
  children: ScreenUINode[] = [],
): ScreenUINode => ({
  ref: `ax-${name}`,
  role,
  name,
  bounds: { x: 0, y: 0, w: 1, h: 1 },
  states: [],
  actions,
  children,
});

test("the UI tree reads in order with each element's depth and the ref agents use", () => {
  const { rows, truncated } = treeRows({
    nodes: [
      node(
        "Cell",
        "Wi-Fi",
        ["press"],
        [node("Switch", "Toggle", ["press"]), node("Text", "Label", [])],
      ),
    ],
    truncated: true,
  });

  expect(rows.map((row) => [row.depth, row.ref, row.role, row.name])).toEqual([
    [0, "e2", "Cell", "Wi-Fi"],
    [1, "e1", "Switch", "Toggle"],
    [1, "", "Text", "Label"],
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  expect(truncated).toBe(true);
});
