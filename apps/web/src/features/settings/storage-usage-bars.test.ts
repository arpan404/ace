import { expect, test } from "vitest";
import { usageBars } from "./storage-usage-bars.ts";

test("usage rows read largest first, each bar measured against the largest row", () => {
  const rows = usageBars([
    { key: "threads", bytes: 776 },
    { key: "artifacts", bytes: 3_200 },
    { key: "logs", bytes: 446 },
    { key: "database", bytes: 26_000 },
  ]);
  expect(rows.map((row) => [row.key, row.share])).toEqual([
    ["database", 1],
    ["artifacts", 3_200 / 26_000],
    ["threads", 776 / 26_000],
    ["logs", 446 / 26_000],
  ]);
});

test("rows still being measured go last in their given order, with no bar", () => {
  const rows = usageBars([
    { key: "threads", bytes: undefined },
    { key: "logs", bytes: 10 },
    { key: "caches", bytes: undefined },
    { key: "attachments", bytes: 20 },
  ]);
  expect(rows.map((row) => [row.key, row.share])).toEqual([
    ["attachments", 1],
    ["logs", 0.5],
    ["threads", undefined],
    ["caches", undefined],
  ]);
});

test("empty rows keep an empty bar, and nothing divides by zero when every row is empty", () => {
  const rows = usageBars([
    { key: "worktrees", bytes: 0 },
    { key: "caches", bytes: 0 },
  ]);
  expect(rows.map((row) => [row.key, row.share])).toEqual([
    ["worktrees", 0],
    ["caches", 0],
  ]);
});

test("rows of equal size keep the order they were given", () => {
  const rows = usageBars([
    { key: "b", bytes: 5 },
    { key: "a", bytes: 5 },
    { key: "c", bytes: 9 },
  ]);
  expect(rows.map((row) => row.key)).toEqual(["c", "b", "a"]);
});
