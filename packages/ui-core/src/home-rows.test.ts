import { expect, test } from "vitest";
import {
  focusRows,
  homeFootStart,
  homeRowKey,
  projectFold,
  inboxFold,
  searchRows,
  treeRows,
  type HomeRow,
} from "./home-rows.ts";
import type { HomeTree, TreeProject } from "./home-tree.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: readonly HomeRow[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case "inbox-header":
        return `Inbox ${row.count}${row.open ? "" : " (folded)"}`;
      case "place":
        return `${row.place} ${row.count}`;
      case "projects-label":
        return "Projects";
      case "project-header":
        return `[${row.project}]${row.open ? "" : " (folded)"}`;
      case "project-settled":
        return `${row.count} settled${row.open ? " (open)" : ""}`;
      case "quiet-header":
        return `Quiet ${row.count}${row.open ? " (open)" : ""}`;
      case "quiet-project":
        return `quiet ${row.project} ${row.settled}`;
      case "snoozed-header":
        return `Snoozed ${row.count}`;
      case "settled-more":
        return `more ${row.state}`;
      case "empty":
        return row.text;
      case "label":
        return row.count === undefined ? row.label : `${row.label} · ${row.count}`;
      case "unsent":
        return "unsent";
      case "thread":
        return row.withProject ? `${row.id}@` : row.id;
      default:
        return row.id;
    }
  });

const project = (id: string, patch: Partial<TreeProject> = {}): TreeProject => ({
  id,
  threads: [],
  open: [],
  running: 0,
  inbox: 0,
  settled: [],
  settledTotal: 0,
  ...patch,
});

const built = (patch: Partial<HomeTree> = {}): HomeTree => ({
  inbox: [],
  running: [],
  recent: [],
  projects: [],
  quiet: [],
  order: [],
  ...patch,
});

test("the Inbox leads with its threads, then Running, Recent and each project", () => {
  const rows = treeRows(
    built({
      inbox: ["asks"],
      running: ["works"],
      recent: [{ id: "old", at: 1, settled: true }],
      projects: [project("ace", { threads: ["works", "rests"], open: ["works", "rests"] })],
    }),
    { includeUnsent: true },
  );
  expect(words(rows)).toEqual([
    "unsent",
    "Inbox 1",
    "asks@",
    "running 1",
    "recent 1",
    "Projects",
    "[ace]",
    "works",
    "rests",
  ]);
});

test("an empty Inbox says the person is all caught up", () => {
  expect(words(treeRows(built())).slice(0, 2)).toEqual(["Inbox 0", "You’re all caught up."]);
});

test("a folded project keeps only the open thread in sight", () => {
  const tree = built({ projects: [project("ace", { threads: ["a", "b"], open: ["a", "b"] })] });
  const folded = [projectFold("ace")];
  expect(words(treeRows(tree, { collapsed: folded })).slice(-1)).toEqual(["[ace] (folded)"]);
  expect(words(treeRows(tree, { collapsed: folded, current: "b" })).slice(-2)).toEqual([
    "[ace] (folded)",
    "b",
  ]);
  expect(words(treeRows(tree, { collapsed: [inboxFold] }))[0]).toBe("Inbox 0 (folded)");
});

test("N settled opens that project's settled threads in place, with a foot while more load", () => {
  const tree = built({
    projects: [
      project("ace", { threads: ["a"], open: ["a"], settled: ["s1", "s2"], settledTotal: 5 }),
      project("web", { threads: ["w"], open: ["w"], settled: ["s3"], settledTotal: 1 }),
    ],
  });
  expect(words(treeRows(tree)).slice(-6)).toEqual([
    "[ace]",
    "a",
    "5 settled",
    "[web]",
    "w",
    "1 settled",
  ]);
  const open = treeRows(tree, { settledOpen: ["ace"], settledFoot: () => "loading" });
  expect(words(open).slice(-9)).toEqual([
    "[ace]",
    "a",
    "5 settled (open)",
    "s1",
    "s2",
    "more loading",
    "[web]",
    "w",
    "1 settled",
  ]);
});

test("quiet projects fold under one heading at the foot of Projects", () => {
  const tree = built({
    projects: [project("ace", { threads: ["a"], open: ["a"] })],
    quiet: [project("docs", { settledTotal: 4 }), project("cli", { settledTotal: 1 })],
  });
  expect(words(treeRows(tree)).slice(-1)).toEqual(["Quiet 2"]);
  expect(words(treeRows(tree, { quietOpen: true })).slice(-3)).toEqual([
    "Quiet 2 (open)",
    "quiet docs 4",
    "quiet cli 1",
  ]);
});

test("Snoozed closes the list, below the free space", () => {
  const rows = treeRows(built(), { snoozed: ["z"], snoozedOpen: true });
  expect(words(rows).slice(-2)).toEqual(["Snoozed 1", "z"]);
  expect(homeFootStart(rows.map((item) => ({ item })))).toBe(rows.length - 2);
});

test("Running's focused list names each thread's project", () => {
  const tree = built({ running: ["w", "i"] });
  expect(words(focusRows({ kind: "running" }, { tree, now: 0 }))).toEqual(["w@", "i@"]);
});

test("Recent's focused list groups by day, newest first", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 9, 31, 15).getTime();
  const tree = built({
    recent: [
      { id: "a", at: now - 1000, settled: false },
      { id: "b", at: now - day, settled: true },
      { id: "c", at: now - 3 * day, settled: true },
    ],
  });
  expect(words(focusRows({ kind: "recent" }, { tree, now }))).toEqual([
    "Today",
    "a",
    "Yesterday",
    "b",
    "Earlier this week",
    "c",
  ]);
});

test("a project's focused tabs list its open threads, Inbox ones included, or its settled", () => {
  const tree = built({
    projects: [project("ace", { threads: ["b"], open: ["a", "b"], settled: ["s"] })],
  });
  const active = focusRows({ kind: "project", id: "ace", tab: "active" }, { tree, now: 0 });
  expect(words(active)).toEqual(["a", "b"]);
  const settled = focusRows(
    { kind: "project", id: "ace", tab: "settled" },
    { tree, now: 0, foot: "more" },
  );
  expect(words(settled)).toEqual(["s", "more more"]);
});

test("search lists matching threads, then settled matches, each under its count", () => {
  expect(words(searchRows(["a"], ["s1", "s2"]))).toEqual([
    "Threads · 1",
    "a@",
    "Settled · 2",
    "s1",
    "s2",
  ]);
});

test("no thread id can take a heading's key, and a thread keeps its key in any place", () => {
  const thread: HomeRow = {
    kind: "thread",
    id: "section:inbox-header",
    place: "inbox",
    withProject: true,
  };
  const header: HomeRow = { kind: "inbox-header", count: 0, open: true };
  expect(homeRowKey(thread)).not.toBe(homeRowKey(header));
  expect(homeRowKey({ kind: "thread", id: "x", place: "inbox", withProject: true })).toBe(
    homeRowKey({ kind: "thread", id: "x", place: "project", withProject: false }),
  );
});
