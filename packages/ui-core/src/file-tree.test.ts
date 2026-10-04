import { expect, test } from "vitest";
import { changeTreeRows, type TreeFile } from "./file-tree.ts";

const files: TreeFile[] = [
  { path: "apps/server/src/replay.ts", additions: 12, deletions: 3 },
  { path: "README.md", additions: 1, deletions: 0 },
  { path: "apps/web/src/relay/outbox.ts", additions: 4, deletions: 2 },
  { path: "apps/server/src/replay.test.ts", additions: 30, deletions: 0 },
];

const outline = (rows: ReturnType<typeof changeTreeRows>) =>
  rows.map(
    (row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/` : row.name}`,
  );

test("folders come before files, chains of single folders join, and every level is sorted", () => {
  expect(outline(changeTreeRows(files))).toEqual([
    "apps/",
    "  server/src/",
    "    replay.test.ts",
    "    replay.ts",
    "  web/src/relay/",
    "    outbox.ts",
    "README.md",
  ]);
});

test("a folder adds up the lines its files gained and lost", () => {
  const apps = changeTreeRows(files).find((row) => row.kind === "folder" && row.key === "apps");
  expect(apps).toMatchObject({ additions: 46, deletions: 5, files: 3 });
  const server = changeTreeRows(files).find((row) => row.key === "apps/server/src");
  expect(server).toMatchObject({ additions: 42, deletions: 3, files: 2 });
});

test("a collapsed folder hides what is inside it but keeps its totals", () => {
  const rows = changeTreeRows(files, { collapsed: new Set(["apps/server/src"]) });
  expect(outline(rows)).toEqual([
    "apps/",
    "  server/src/",
    "  web/src/relay/",
    "    outbox.ts",
    "README.md",
  ]);
  expect(rows[1]).toMatchObject({ open: false, additions: 42 });
});

test("a file row points at its place in the list it came from, to jump to its diff", () => {
  const rows = changeTreeRows(files);
  const outbox = rows.find((row) => row.kind === "file" && row.name === "outbox.ts");
  expect(outbox?.kind === "file" && outbox.index).toBe(2);
});

test("filtering shows only matching files with their folders, even inside collapsed ones", () => {
  const rows = changeTreeRows(files, { filter: "REPLAY", collapsed: new Set(["apps/server/src"]) });
  expect(outline(rows)).toEqual(["apps/server/src/", "  replay.test.ts", "  replay.ts"]);
  expect(changeTreeRows(files, { filter: "nothing-matches" })).toEqual([]);
});

test("numbered names sort as numbers", () => {
  const rows = changeTreeRows([
    { path: "case-10.ts", additions: 1, deletions: 0 },
    { path: "case-2.ts", additions: 1, deletions: 0 },
  ]);
  expect(rows.map((row) => row.name)).toEqual(["case-2.ts", "case-10.ts"]);
});
