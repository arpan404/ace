import { expect, test } from "vitest";
import {
  homeFootStart,
  homeRowKey,
  projectFold,
  projectMore,
  treeRows,
  type HomeRow,
} from "./home-rows.ts";
import type { HomeTree, TreeProject } from "./home-tree.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: readonly HomeRow[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case "active-label":
        return "Active";
      case "projects-label":
        return "Projects";
      case "project-header":
        return `[${row.project}]${row.open ? "" : " (folded)"}`;
      case "quiet-header":
        return `Quiet ${row.count}${row.open ? " (open)" : ""}`;
      case "quiet-project":
        return `quiet ${row.project}`;
      case "snoozed-header":
        return `Snoozed ${row.count}`;
      case "empty":
        return row.text;
      case "show-more":
        return row.open ? "Show less" : `Show ${row.hidden} more`;
      case "project-history":
        return `${row.count} in History`;
      case "unsent":
        return "unsent";
      case "thread":
        return row.place === "pinned" ? `${row.id} (pinned)` : row.id;
      case "settled":
        return `${row.id} (settled)`;
      default:
        return "id" in row ? row.id : row.day;
    }
  });

const project = (id: string, patch: Partial<TreeProject> = {}): TreeProject => ({
  id,
  settled: [],
  active: 0,
  held: 0,
  ...patch,
});

const built = (patch: Partial<HomeTree> = {}): HomeTree => ({
  active: [],
  projects: [],
  quiet: [],
  order: [],
  settled: [],
  ...patch,
});

test("Active leads the panel; each project below holds only its settled threads", () => {
  const rows = treeRows(
    built({
      active: ["asks", "works"],
      projects: [project("ace", { settled: ["done"], active: 2 })],
    }),
    { includeUnsent: true },
  );
  expect(words(rows)).toEqual([
    "unsent",
    "Active",
    "asks",
    "works",
    "Projects",
    "[ace]",
    "done (settled)",
  ]);
});

test("pinned threads in Active are marked as pinned", () => {
  const tree = built({ active: ["pin", "works"] });
  expect(words(treeRows(tree, { pinned: ["pin", "gone"] }))).toEqual([
    "Active",
    "pin (pinned)",
    "works",
  ]);
});

test("a project whose threads are all Active is its row alone", () => {
  const rows = treeRows(built({ active: ["a"], projects: [project("ace", { active: 1 })] }));
  expect(words(rows)).toEqual(["Active", "a", "Projects", "[ace]"]);
});

test("a project's settled threads the daemon holds back are one row away, in History", () => {
  const few = built({ projects: [project("ace", { settled: ["s"], held: 12 })] });
  expect(words(treeRows(few)).slice(-2)).toEqual(["s (settled)", "12 in History"]);
  const none = built({ projects: [project("ace", { held: 4 })] });
  expect(words(treeRows(none)).slice(-1)).toEqual(["4 in History"]);
});

test("a folded project keeps only the open thread in sight", () => {
  const tree = built({ projects: [project("ace", { settled: ["a", "b"] })] });
  const folded = [projectFold("ace")];
  expect(words(treeRows(tree, { collapsed: folded })).slice(-1)).toEqual(["[ace] (folded)"]);
  expect(words(treeRows(tree, { collapsed: folded, current: "b" })).slice(-2)).toEqual([
    "[ace] (folded)",
    "b (settled)",
  ]);
});

test("quiet projects fold under one heading at the foot of Projects", () => {
  const tree = built({
    projects: [project("ace", { settled: ["a"] })],
    quiet: ["docs", "cli"],
  });
  expect(words(treeRows(tree)).slice(-1)).toEqual(["Quiet 2"]);
  expect(words(treeRows(tree, { quietOpen: true })).slice(-3)).toEqual([
    "Quiet 2 (open)",
    "quiet docs",
    "quiet cli",
  ]);
});

test("Snoozed closes the list, below the free space", () => {
  const rows = treeRows(built(), { snoozed: ["z"], snoozedOpen: true });
  expect(words(rows).slice(-2)).toEqual(["Snoozed 1", "z"]);
  expect(homeFootStart(rows.map((item) => ({ item })))).toBe(rows.length - 2);
});

test("an open project shows five settled rows, then Show more with how many it holds back", () => {
  const settled = ["a", "b", "c", "d", "e", "f", "g"];
  const tree = built({ projects: [project("ace", { settled, held: 3 })] });
  expect(words(treeRows(tree)).slice(1)).toEqual([
    "[ace]",
    "a (settled)",
    "b (settled)",
    "c (settled)",
    "d (settled)",
    "e (settled)",
    "Show 2 more",
  ]);
  expect(words(treeRows(tree, { collapsed: [projectMore("ace")] })).slice(-4)).toEqual([
    "f (settled)",
    "g (settled)",
    "Show less",
    "3 in History",
  ]);
});

test("the open thread stays in sight past Show more", () => {
  const settled = ["a", "b", "c", "d", "e", "f", "g"];
  const tree = built({ projects: [project("ace", { settled })] });
  expect(words(treeRows(tree, { current: "g" })).slice(-3)).toEqual([
    "e (settled)",
    "g (settled)",
    "Show 1 more",
  ]);
});

test("no thread id can take a heading's key, and a thread keeps its key in any place", () => {
  const thread: HomeRow = { kind: "thread", id: "section:projects-label", place: "active" };
  expect(homeRowKey(thread)).not.toBe(homeRowKey({ kind: "projects-label" }));
  expect(homeRowKey({ kind: "thread", id: "x", place: "pinned" })).toBe(
    homeRowKey({ kind: "settled", id: "x" }),
  );
});
