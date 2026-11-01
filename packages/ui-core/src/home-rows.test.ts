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
      case "pinned-label":
        return "Pinned";
      case "show-more":
        return row.open ? "Show less" : `Show ${row.hidden} more`;
      case "unsent":
        return "unsent";
      case "thread":
        return row.place === "pinned" ? `${row.id} (pinned)` : row.id;
      case "recently-settled":
        return `${row.id} (settled)`;
      default:
        return "id" in row ? row.id : row.day;
    }
  });

const project = (id: string, patch: Partial<TreeProject> = {}): TreeProject => ({
  id,
  threads: [],
  running: 0,
  inbox: 0,
  recent: [],
  ...patch,
});

const built = (patch: Partial<HomeTree> = {}): HomeTree => ({
  inbox: [],
  projects: [],
  quiet: [],
  order: [],
  settled: [],
  ...patch,
});

test("the panel lists projects only: each with its open threads, then its recently settled", () => {
  const rows = treeRows(
    built({
      inbox: ["asks"],
      projects: [project("ace", { threads: ["works", "rests"], recent: ["done"], inbox: 1 })],
    }),
    { includeUnsent: true },
  );
  expect(words(rows)).toEqual(["unsent", "Projects", "[ace]", "works", "rests", "done (settled)"]);
});

test("a project whose threads all wait in the Inbox says where they are", () => {
  const rows = treeRows(built({ inbox: ["asks"], projects: [project("ace", { inbox: 1 })] }));
  expect(words(rows).slice(-1)).toEqual(["Nothing open. Waiting items are in your Inbox."]);
});

test("a folded project keeps only the open thread in sight", () => {
  const tree = built({ projects: [project("ace", { threads: ["a", "b"], recent: ["s"] })] });
  const folded = [projectFold("ace")];
  expect(words(treeRows(tree, { collapsed: folded })).slice(-1)).toEqual(["[ace] (folded)"]);
  expect(words(treeRows(tree, { collapsed: folded, current: "b" })).slice(-2)).toEqual([
    "[ace] (folded)",
    "b",
  ]);
  expect(words(treeRows(tree, { collapsed: folded, current: "s" })).slice(-2)).toEqual([
    "[ace] (folded)",
    "s (settled)",
  ]);
});

test("quiet projects fold under one heading at the foot of Projects", () => {
  const tree = built({
    projects: [project("ace", { threads: ["a"] })],
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

test("pinned threads lead the panel under Pinned and leave their projects", () => {
  const tree = built({
    inbox: ["asks"],
    projects: [project("ace", { threads: ["pin", "works"], inbox: 1 })],
  });
  // A pinned thread waiting in the Inbox stays there: never shown twice.
  expect(words(treeRows(tree, { pinned: ["asks", "pin"] }))).toEqual([
    "Pinned",
    "pin (pinned)",
    "Projects",
    "[ace]",
    "works",
  ]);
});

test("an open project shows five rows, then Show more with how many it holds back", () => {
  const threads = ["a", "b", "c", "d", "e", "f"];
  const tree = built({ projects: [project("ace", { threads, recent: ["s"] })] });
  expect(words(treeRows(tree)).slice(1)).toEqual(["[ace]", "a", "b", "c", "d", "e", "Show 2 more"]);
  expect(words(treeRows(tree, { collapsed: [projectMore("ace")] })).slice(-3)).toEqual([
    "f",
    "s (settled)",
    "Show less",
  ]);
});

test("the open thread stays in sight past Show more", () => {
  const threads = ["a", "b", "c", "d", "e", "f", "g"];
  const tree = built({ projects: [project("ace", { threads })] });
  expect(words(treeRows(tree, { current: "g" })).slice(-3)).toEqual(["e", "g", "Show 1 more"]);
});

test("no thread id can take a heading's key, and a thread keeps its key in any place", () => {
  const thread: HomeRow = { kind: "thread", id: "section:projects-label", place: "project" };
  expect(homeRowKey(thread)).not.toBe(homeRowKey({ kind: "projects-label" }));
  expect(homeRowKey({ kind: "thread", id: "x", place: "pinned" })).toBe(
    homeRowKey({ kind: "recently-settled", id: "x" }),
  );
});
