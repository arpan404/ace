import type { FolderEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import { chainedOpenFolders, compactFolderRows } from "./folder-chains.ts";
import { emptyFolder, type FolderState, type FolderStates } from "./folder-tree.ts";

const entry = (path: string, kind: FolderEntry["kind"]): FolderEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind,
  size: 0,
  mtimeMs: 0,
  ignored: false,
});
const listed = (...entries: FolderEntry[]): FolderState => ({
  ...emptyFolder,
  entries,
  nextCursor: null,
  total: entries.length,
});
const dir = (path: string) => entry(path, "directory");
const file = (path: string) => entry(path, "file");

/** apps holds only web, web holds only src, src holds two files; README beside apps. */
const chain: FolderStates = {
  "": listed(dir("apps"), file("README.md")),
  "apps/": listed(dir("apps/web")),
  "apps/web/": listed(dir("apps/web/src")),
  "apps/web/src/": listed(file("apps/web/src/a.ts"), file("apps/web/src/b.ts")),
};
const shown = (rows: ReturnType<typeof compactFolderRows>) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.name}${row.expanded ? " ▾" : ""}`);

test("a folder whose only entry is a folder joins its row, and opening the first opens the chain", () => {
  const open = chainedOpenFolders(chain, new Set(["apps/"]));
  expect([...open].toSorted()).toEqual(["apps/", "apps/web/", "apps/web/src/"]);
  const rows = compactFolderRows(chain, open);
  expect(shown(rows)).toEqual(["apps/web/src ▾", "  a.ts", "  b.ts", "README.md"]);
  // The row acts on its last folder and folds as its first does.
  expect(rows[0]?.key).toBe("apps/web/src/");
  expect(rows[0]?.chain).toEqual(["apps/", "apps/web/", "apps/web/src/"]);
});

test("a folded chain stays one row, and nothing under it counts as open", () => {
  const open = chainedOpenFolders(chain, new Set());
  expect([...open]).toEqual([]);
  expect(shown(compactFolderRows(chain, open))).toEqual(["apps/web/src", "README.md"]);
});

test("a chain is only as long as what is listed: an unlisted folder ends it until it arrives", () => {
  const partial: FolderStates = { "": chain[""] ?? emptyFolder, "apps/": listed(dir("apps/web")) };
  const open = chainedOpenFolders(partial, new Set(["apps/"]));
  expect([...open].toSorted()).toEqual(["apps/", "apps/web/"]);
  const rows = compactFolderRows(partial, open);
  expect(shown(rows)).toEqual(["apps/web ▾", "    Loading…", "README.md"]);
  expect(rows[0]?.busy).toBe(true);
});

test("a folder with more than one entry, or a page still to come, doesn't chain", () => {
  const two: FolderStates = {
    "": listed(dir("apps")),
    "apps/": listed(dir("apps/web"), file("apps/notes.md")),
    "apps/web/": listed(file("apps/web/a.ts")),
  };
  expect(shown(compactFolderRows(two, chainedOpenFolders(two, new Set(["apps/"]))))).toEqual([
    "apps ▾",
    "  web",
    "  notes.md",
  ]);
  const paged: FolderStates = {
    "": listed(dir("apps")),
    "apps/": { ...listed(dir("apps/web")), nextCursor: "1" },
  };
  expect(shown(compactFolderRows(paged, chainedOpenFolders(paged, new Set(["apps/"]))))).toEqual([
    "apps ▾",
    "  web",
    "    Show more",
  ]);
});

test("the root's only folder starts a chain but isn't opened by it", () => {
  const lone: FolderStates = { "": listed(dir("src")), "src/": listed(file("src/a.ts")) };
  expect([...chainedOpenFolders(lone, new Set([""]))]).toEqual([""]);
  expect(shown(compactFolderRows(lone, new Set([""])))).toEqual(["src"]);
});
