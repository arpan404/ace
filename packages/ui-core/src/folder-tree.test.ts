import type { FolderEntry, FolderPage } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  folderKey,
  folderPageArrived,
  folderPageFailed,
  folderRequestRepeated,
  folderRequestSettled,
  folderRequestStarted,
  folderRequestLimit,
  folderDepth,
  orderedFolderRequests,
  relistLimit,
  retryPage,
  folderRows,
  folderStopped,
  foldersToRelist,
  openedFolders,
  revealingFolders,
  startingFolderPage,
  toggledFolders,
  visibleOpenFolders,
  watchedFolders,
  emptyFolder,
  noFolderRequests,
  type FolderStates,
} from "./folder-tree.ts";

const file = (path: string, ignored = false): FolderEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "file",
  size: 1,
  mtimeMs: 0,
  ignored,
});
const folder = (path: string, ignored = false): FolderEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "directory",
  size: 0,
  mtimeMs: 0,
  ignored,
});
const page = (
  entries: FolderEntry[],
  nextCursor: string | null,
  total = entries.length,
): FolderPage => ({
  entries,
  nextCursor,
  total,
});

test("pages merge in order without gaps or duplicates", () => {
  let folders: FolderStates = startingFolderPage({}, "", true);
  folders = folderPageArrived(
    folders,
    "",
    page([folder("lib"), file("a.ts")], "two", 4),
    undefined,
  );
  folders = folderPageArrived(folders, "", page([file("a.ts"), file("b.ts")], null, 4), "two");
  expect(folders[""]?.entries.map((entry) => entry.path)).toEqual(["lib", "a.ts", "b.ts"]);
  expect(folders[""]?.nextCursor).toBeNull();
  expect(folders[""]?.total).toBe(4);
  expect(folders[""]?.loading).toBe(false);
});

test("a page for a cursor the folder moved past is ignored rather than leaving a gap", () => {
  const listed = folderPageArrived({}, "", page([file("a.ts")], "next", 3), undefined);
  const stale = folderPageArrived(listed, "", page([file("b.ts")], null, 3), "other");
  expect(stale).toBe(listed);
});

test("INVALID_CURSOR forgets the folder's pages and starts it again", () => {
  const listed = folderPageArrived({}, "src/", page([file("src/a.ts")], "next", 2), undefined);
  const failed = folderPageFailed(listed, "src/", {
    code: "INVALID_CURSOR",
    message: "This folder changed while it was loading. Open it again.",
  });
  expect(failed["src/"]).toEqual({
    entries: [],
    nextCursor: undefined,
    total: 0,
    loading: true,
    error: undefined,
  });
});

test("any other page failure keeps the entries listed and says why the next page stopped", () => {
  const listed = folderPageArrived({}, "", page([file("a.ts")], "next", 2), undefined);
  const failed = folderPageFailed(listed, "", { code: "IO_ERROR", message: "Couldn't list." });
  expect(failed[""]?.entries.map((entry) => entry.path)).toEqual(["a.ts"]);
  expect(failed[""]?.nextCursor).toBe("next");
  expect(failed[""]?.loading).toBe(false);
  expect(failed[""]?.error).toBe("Couldn't list.");
});

test("folding an open folder keeps its loaded children for when it opens again", () => {
  let folders: FolderStates = folderPageArrived(
    {},
    "src/",
    page([file("src/a.ts"), file("src/b.ts")], null, 2),
    undefined,
  );
  folders = folderPageArrived(folders, "", page([folder("src")], null, 1), undefined);
  const open = new Set(["src/"]);
  expect(folderRows(folders, open).map((row) => row.key)).toEqual(["src/", "src/a.ts", "src/b.ts"]);
  const folded = new Set<string>();
  expect(folderRows(folders, folded).map((row) => row.key)).toEqual(["src/"]);
  // Nothing was dropped: opening it again shows the same rows without another page.
  expect(folderRows(folders, open).map((row) => row.key)).toEqual(["src/", "src/a.ts", "src/b.ts"]);
  expect(folders["src/"]?.entries).toHaveLength(2);
});

test("a change in one open folder re-lists only that folder and leaves the open set alone", () => {
  const open = new Set(["", "src/", "docs/"]);
  expect(foldersToRelist(open, ["src"], false)).toEqual(["src/"]);
  expect([...open]).toEqual(["", "src/", "docs/"]);
});

test("a rescan re-lists every open folder", () => {
  expect(foldersToRelist(new Set(["", "src/", "docs/"]), [], true)).toEqual(["", "src/", "docs/"]);
});

test("a folder still loading shows one Loading row and a folder with more pages shows Show more", () => {
  let folders: FolderStates = {};
  expect(folderRows(folders, new Set([""])).map((row) => row.kind)).toEqual(["loading"]);
  folders = folderPageArrived(
    folders,
    "",
    page([folder("src"), file("a.ts")], "next", 3),
    undefined,
  );
  expect(folderRows(folders, new Set([""])).map((row) => `${row.kind}:${row.name}`)).toEqual([
    "folder:src",
    "file:a.ts",
    "more:Show more",
  ]);
  // Listing the folder again keeps its rows while the new page is on its way.
  folders = startingFolderPage(folders, "", true);
  expect(folderRows(folders, new Set([""])).map((row) => `${row.kind}:${row.name}`)).toEqual([
    "folder:src",
    "file:a.ts",
  ]);
});

test("a folder with nothing listed yet shows Loading, and its row is busy", () => {
  const folders = folderPageArrived({}, "", page([folder("src")], null, 1), undefined);
  const rows = folderRows(folders, new Set(["", "src/"]));
  expect(rows.map((row) => `${row.key}:${row.kind}:${row.busy}`)).toEqual([
    "src/:folder:true",
    "loading:src/:loading:false",
  ]);
  const listed = folderPageArrived(folders, "src/", page([file("src/a.ts")], null, 1), undefined);
  expect(folderRows(listed, new Set(["", "src/"])).map((row) => `${row.key}:${row.busy}`)).toEqual([
    "src/:false",
    "src/a.ts:false",
  ]);
});

test("stopping the request for a folder clears its loading state", () => {
  const loading = startingFolderPage({}, "src/", true);
  expect(loading["src/"]?.loading).toBe(true);
  expect(folderStopped(loading, "src/")["src/"]?.loading).toBe(false);
  expect(folderStopped({}, "src/")).toEqual({});
});

test("only folders with every ancestor open are visible, and folding keeps what they loaded", () => {
  expect([...visibleOpenFolders(["", "apps/", "apps/web/"])]).toEqual(["", "apps/", "apps/web/"]);
  expect([...visibleOpenFolders(["apps/web/"])]).toEqual([""]);
  expect([...visibleOpenFolders(["apps/", "docs/", "docs/api/"])]).toEqual([
    "",
    "apps/",
    "docs/",
    "docs/api/",
  ]);
  let folders = folderPageArrived({}, "", page([folder("apps")], null, 1), undefined);
  folders = folderPageArrived(folders, "apps/", page([folder("apps/web")], null, 1), undefined);
  folders = folderPageArrived(
    folders,
    "apps/web/",
    page([file("apps/web/a.ts")], null, 1),
    undefined,
  );
  // Folding apps/ hides apps/web/'s rows without listing anything; its state waits for it.
  expect(folderRows(folders, new Set(["apps/"])).map((row) => row.key)).toEqual([
    "apps/",
    "apps/web/",
  ]);
  expect(folders["apps/web/"]?.entries).toHaveLength(1);
});

test("retrying a failed next page asks for that page, not the folder's first", () => {
  const first = folderPageArrived({}, "", page([file("a.ts")], "next", 2), undefined);
  const failedMore = folderPageFailed(first, "", { code: "IO_ERROR", message: "Couldn't list." });
  expect(retryPage(failedMore[""])).toEqual({ mode: "more", cursor: "next" });
  const failedFirst = folderPageFailed({}, "src/", { code: "IO_ERROR", message: "Couldn't list." });
  expect(retryPage(failedFirst["src/"])).toEqual({ mode: "first" });
  expect(retryPage(undefined)).toEqual({ mode: "first" });
});

test("only open folders show their entries, one level under their folder", () => {
  let folders: FolderStates = folderPageArrived(
    {},
    "",
    page([folder("src"), folder("docs"), file("README.md")], null, 3),
    undefined,
  );
  folders = folderPageArrived(
    folders,
    "src/",
    page([folder("src/lib"), file("src/app.ts")], null, 2),
    undefined,
  );
  const rows = folderRows(folders, new Set(["src/"]));
  expect(rows.map((row) => `${row.depth}:${row.key}:${row.expanded}`)).toEqual([
    "0:src/:true",
    "1:src/lib/:false",
    "1:src/app.ts:false",
    "0:docs/:false",
    "0:README.md:false",
  ]);
});

test("ignored entries are kept and flagged, not dropped", () => {
  const folders = folderPageArrived(
    {},
    "",
    page([folder(".cache", true), file("dist/old.js", true), file("a.ts")], null, 3),
    undefined,
  );
  expect(folderRows(folders, new Set([""])).map((row) => [row.key, row.ignored])).toEqual([
    [".cache/", true],
    ["dist/old.js", true],
    ["a.ts", false],
  ]);
});

test("the current file's ancestors open until the person chooses otherwise", () => {
  const current = "apps/web/src/socket.ts";
  expect([...openedFolders(undefined, current)]).toEqual(["apps/", "apps/web/", "apps/web/src/"]);
  expect(openedFolders(undefined, undefined).size).toBe(0);
  const chosen = new Set(["docs/"]);
  expect([...openedFolders(["docs/"], current)]).toEqual(["docs/"]);
  expect(revealingFolders(chosen, current)).toEqual(["apps/", "apps/web/", "apps/web/src/"]);
  expect([...toggledFolders(chosen, "docs/", false)]).toEqual([]);
  expect([...toggledFolders(chosen, "src/", true)]).toEqual(["docs/", "src/"]);
});

test("watch names the root and every open folder without trailing slashes, once", () => {
  expect(watchedFolders(["", "src/", "src/", "docs/"])).toEqual(["", "docs", "src"]);
  expect(watchedFolders(Array.from({ length: 600 }, (_, n) => `f${n}/`))).toHaveLength(512);
  expect(folderKey("src")).toBe("src/");
  expect(folderKey("")).toBe("");
});

test("a re-list asks for what the folder already shows, between 500 and 5000", () => {
  expect(relistLimit(undefined)).toBe(500);
  expect(relistLimit({ ...emptyFolder, entries: [] })).toBe(500);
  expect(
    relistLimit({
      ...emptyFolder,
      entries: Array.from({ length: 1200 }, (_, n) => file(`f${n}.ts`)),
    }),
  ).toBe(1200);
  expect(
    relistLimit({
      ...emptyFolder,
      entries: Array.from({ length: 9000 }, (_, n) => file(`f${n}.ts`)),
    }),
  ).toBe(5000);
});

test("a re-list asked for while a request is on its way happens once when it ends", () => {
  let requests = folderRequestStarted(noFolderRequests, "src/", 1);
  requests = folderRequestRepeated(requests, "src/");
  requests = folderRequestRepeated(requests, "src/");
  expect(requests.requests["src/"]).toEqual({ token: 1, dirty: true });
  const settled = folderRequestSettled(requests, "src/", 1);
  expect(settled.relist).toBe(true);
  expect(settled.state.requests["src/"]).toBeUndefined();
  // The same reply again is stale: no second re-list.
  expect(folderRequestSettled(settled.state, "src/", 1)).toEqual({
    state: settled.state,
    relist: false,
  });
});

test("a reply for a token the folder moved past is stale and leaves the newer request", () => {
  let requests = folderRequestStarted(noFolderRequests, "src/", 1);
  requests = folderRequestStarted(requests, "src/", 2);
  expect(folderRequestSettled(requests, "src/", 1)).toEqual({ state: requests, relist: false });
  expect(requests.requests["src/"]?.token).toBe(2);
  expect(folderRequestRepeated(noFolderRequests, "src/").requests["src/"]).toBeUndefined();
});

test("pending requests go visible first, shallower first, then by path", () => {
  expect(folderDepth("")).toBe(0);
  expect(folderDepth("src/")).toBe(1);
  expect(folderDepth("src/lib/")).toBe(2);
  const visible = new Set(["", "src/", "src/lib/", "src/deep/"]);
  const ordered = orderedFolderRequests(
    [
      { folder: "src/deep/", mode: "first" },
      { folder: "hidden/deep/", mode: "first" },
      { folder: "src/lib/", mode: "more" },
      { folder: "hidden/", mode: "first" },
      { folder: "src/", mode: "first" },
    ],
    visible,
  );
  expect(ordered.map((request) => request.folder)).toEqual([
    "src/",
    "src/deep/",
    "src/lib/",
    "hidden/",
    "hidden/deep/",
  ]);
  expect(folderRequestLimit).toBe(6);
});
