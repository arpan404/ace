import type { ConnectionState } from "@ace/client";
import {
  FilesServerMessage,
  ServerMessage,
  ThreadId,
  WorkspaceId,
  type FolderEntry,
  type FolderPage,
  type GitStatusFile,
} from "@ace/protocol";
import { expect, test } from "vitest";
import type { TreeOwner } from "./checkout-tree-live.ts";
import { CheckoutTrees, type TreeFiles } from "./checkout-tree-live.ts";
import type { TreeRow } from "./checkout-tree.ts";
import type { FilesScope } from "./checkout-request.ts";
import type { Timers } from "./kept-read.ts";

/*
 * The Files screen's live tree, one folder at a time: the root when it opens, a folder when it is
 * expanded, pages when Show more asks, and the folders the daemon names after a change listed
 * again. The fake client stands in for the socket so the test sees every `files.watch` and every
 * `files.tree` patch the phone would draw.
 */

const thread = ThreadId.parse("t1");
const scope: FilesScope = { threadId: thread };
const project: FilesScope = { workspaceId: WorkspaceId.parse("ace") };
type Patch = Record<string, unknown>;
type Sent = Parameters<TreeOwner["send"]>[0];

const entry = (path: string, kind: FolderEntry["kind"] = "file", ignored = false): FolderEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind,
  size: 0,
  mtimeMs: 0,
  ignored,
});
const folder = (path: string, ignored = false) => entry(path, "directory", ignored);
const page = (
  entries: FolderEntry[],
  nextCursor: string | null = null,
  total = entries.length,
): FolderPage => ({ entries, nextCursor, total });
const change = (path: string, status: GitStatusFile["status"]): GitStatusFile => ({
  path,
  status,
  additions: 0,
  deletions: 0,
  binary: false,
});

function client(initial: ConnectionState = "ready") {
  let generation = initial === "ready" ? 1 : undefined;
  const listeners = new Set<() => void>();
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const sent: Sent[] = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const owner: TreeOwner = {
    connectionGeneration: () => ({
      getSnapshot: () => generation,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    send: (message) => {
      sent.push(message);
    },
  };
  return {
    owner,
    sent,
    /** A socket came back (or a new one arrived). */
    connect(next = (generation ?? 0) + 1) {
      generation = next;
      notify();
    },
    disconnect() {
      generation = undefined;
      notify();
    },
    push(message: ServerMessage) {
      for (const listener of messageListeners) listener(message);
    },
  };
}

function files() {
  const calls: { folder: string; cursor: string | undefined; scope: FilesScope }[] = [];
  let contents: (folder: string, cursor: string | undefined) => FolderPage = noPage;
  let marks: readonly GitStatusFile[] = [];
  let statusGate: Promise<void> | undefined;
  let releaseStatus: (() => void) | undefined;
  const source: TreeFiles = {
    async listFolder(requested, directory, cursor) {
      calls.push({ folder: directory, cursor, scope: requested });
      return contents(directory, cursor);
    },
    async status() {
      if (statusGate) await statusGate;
      return marks;
    },
  };
  return {
    source,
    calls,
    /** What each folder's page holds, by folder path ("" is the root) and cursor. */
    setPages(read: (folder: string, cursor: string | undefined) => FolderPage) {
      contents = read;
    },
    setStatus(next: readonly GitStatusFile[]) {
      marks = next;
    },
    /** Hold git's answer until the returned function is called. */
    holdStatus() {
      statusGate = new Promise((resolve) => {
        releaseStatus = resolve;
      });
      return () => {
        statusGate = undefined;
        releaseStatus?.();
      };
    },
    folders: () => calls.map((call) => call.folder),
  };
}

function screen() {
  const patches: Patch[] = [];
  return {
    patches,
    put: (_key: string, read: () => Patch | undefined) => {
      const value = read();
      if (value) patches.push(value);
    },
    last: () => patches.at(-1),
  };
}

/** Timers the test fires by hand. */
function handTimers(): Timers & { fire(): void } {
  const due: (() => void)[] = [];
  return {
    set(_delay, callback) {
      due.push(callback);
      return () => due.splice(due.indexOf(callback) >>> 0, 1);
    },
    fire: () => due.splice(0).forEach((callback) => callback()),
  };
}

const settle = async () => {
  for (let tick = 0; tick < 6; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const noPage = () => page([]);
const rowsOf = (patch: Patch | undefined): TreeRow[] => (patch?.rows ?? []) as TreeRow[];
const keys = (patch: Patch | undefined) => rowsOf(patch).map((row) => row.key);
const watches = (sent: Sent[]) =>
  sent.filter((message) => message.type === "files.watch").map((message) => message.folders);

function opened() {
  const fake = client();
  const tree = files();
  const view = screen();
  const timers = handTimers();
  const trees = new CheckoutTrees(fake.owner, tree.source, view, timers);
  return { fake, tree, view, timers, trees };
}

test("the root is listed when the screen opens, ignored entries flagged, and the open folders watched", async () => {
  const { fake, tree, view, timers, trees } = opened();
  tree.setPages((path) =>
    path === ""
      ? page([folder("src"), entry("dist/old.js", "file", true), entry("a.ts")])
      : page([]),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.folders()).toEqual([""]);
  expect(rowsOf(view.last()).map((row) => `${row.kind}:${row.key}:${row.ignored}`)).toEqual([
    "folder:src/:false",
    "file:dist/old.js:true",
    "file:a.ts:false",
  ]);
  timers.fire();
  expect(watches(fake.sent)).toEqual([[""]]);
});

test("expanding a folder lists it once and folding it hides its rows without listing again", async () => {
  const { tree, view, trees } = opened();
  tree.setPages((path) =>
    path === "" ? page([folder("src"), entry("a.ts")]) : page([entry("src/b.ts")]),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  await settle();
  expect(tree.folders()).toEqual(["", "src"]);
  expect(keys(view.last())).toEqual(["src/", "src/b.ts", "a.ts"]);
  trees.handle({ type: "files.tree.closed", scope, path: "src/" });
  expect(tree.folders()).toEqual(["", "src"]);
  expect(keys(view.last())).toEqual(["src/", "a.ts"]);
});

test("Show more asks for the next page at the cursor and joins the pages without repeats", async () => {
  const { tree, view, trees } = opened();
  tree.setPages((path, cursor) =>
    path === ""
      ? cursor === undefined
        ? page([entry("a.ts")], "two", 2)
        : page([entry("a.ts"), entry("b.ts")], null, 2)
      : page([]),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(keys(view.last())).toEqual(["a.ts", "more:"]);
  trees.handle({ type: "files.tree.more", scope, path: "" });
  await settle();
  expect(tree.calls.at(-1)).toMatchObject({ folder: "", cursor: "two" });
  expect(keys(view.last())).toEqual(["a.ts", "b.ts"]);
});

test("files.folders_changed re-lists only the folder it names", async () => {
  const { fake, tree, view, trees } = opened();
  tree.setPages((path) =>
    path === ""
      ? page([folder("src"), folder("docs")])
      : path === "src"
        ? page([entry("src/new.ts")])
        : page([entry("docs/guide.md")]),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  trees.handle({ type: "files.tree.opened", scope, path: "docs/" });
  await settle();
  expect(tree.folders()).toEqual(["", "src", "docs"]);
  fake.push(
    FilesServerMessage.parse({
      type: "files.folders_changed",
      threadId: thread,
      folders: ["src"],
      rescan: false,
    }),
  );
  await settle();
  expect(tree.folders()).toEqual(["", "src", "docs", "src"]);
  expect(keys(view.last())).toContain("src/new.ts");
  expect(keys(view.last())).toContain("docs/guide.md");
});

test("a rescan lists every open folder again", async () => {
  const { fake, tree, trees } = opened();
  tree.setPages((path) =>
    path === "" ? page([folder("src"), folder("docs")]) : page([entry(`${path}/x.ts`)]),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  trees.handle({ type: "files.tree.opened", scope, path: "docs/" });
  await settle();
  tree.calls.length = 0;
  fake.push(
    FilesServerMessage.parse({
      type: "files.folders_changed",
      threadId: thread,
      folders: [],
      rescan: true,
    }),
  );
  await settle();
  expect(tree.folders()).toEqual(["", "src", "docs"]);
});

test("reconnecting re-lists the open folders and sends the watch set again", async () => {
  const { fake, tree, timers, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("src")]) : page([entry("src/a.ts")])));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  await settle();
  timers.fire();
  fake.sent.length = 0;
  tree.calls.length = 0;
  fake.disconnect();
  fake.connect(2);
  await settle();
  expect(tree.folders()).toEqual(["", "src"]);
  timers.fire();
  expect(watches(fake.sent)).toEqual([["", "src"]]);
});

test("closing the screen stops watching its folders", async () => {
  const { fake, timers, trees } = opened();
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  timers.fire();
  expect(watches(fake.sent)).toEqual([[""]]);
  fake.sent.length = 0;
  trees.handle({ type: "files.tree.hide", scope });
  expect(watches(fake.sent)).toEqual([[]]);
});

test("folders holding a change open at first and deleted files keep their mark", async () => {
  const { tree, view, trees } = opened();
  const outbox = "apps/web/src/relay/outbox.ts";
  const legacy = "apps/web/src/relay/legacy.ts";
  tree.setPages((path) => {
    const pages: Record<string, FolderEntry[]> = {
      "": [folder("apps")],
      apps: [folder("apps/web")],
      "apps/web": [folder("apps/web/src")],
      "apps/web/src": [folder("apps/web/src/relay")],
      "apps/web/src/relay": [entry(outbox)],
    };
    return page(pages[path] ?? []);
  });
  tree.setStatus([change(outbox, "modified"), change(legacy, "deleted")]);
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.folders()).toEqual(["", "apps", "apps/web", "apps/web/src", "apps/web/src/relay"]);
  expect(rowsOf(view.last())).toContainEqual(
    expect.objectContaining({ key: legacy, mark: "D", markLabel: "Deleted" }),
  );
  expect(rowsOf(view.last())).toContainEqual(
    expect.objectContaining({ key: outbox, mark: "M", markLabel: "Modified" }),
  );
});

test("a deleted file at the root shows once git's status arrives after the first page", async () => {
  const { tree, view, trees } = opened();
  const release = tree.holdStatus();
  tree.setPages(() => page([entry("a.ts")]));
  tree.setStatus([change("gone.ts", "deleted")]);
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(rowsOf(view.last()).map((row) => row.key)).toEqual(["a.ts"]);
  release();
  await settle();
  expect(rowsOf(view.last())).toContainEqual(
    expect.objectContaining({ key: "gone.ts", mark: "D", markLabel: "Deleted" }),
  );
});

test("a project's own folder re-lists when that project's files change", async () => {
  const { fake, tree, timers, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("docs")]) : page([entry("docs/a.md")])));
  trees.handle({ type: "files.tree.show", scope: project });
  await settle();
  trees.handle({ type: "files.tree.opened", scope: project, path: "docs/" });
  await settle();
  timers.fire();
  expect(watches(fake.sent)).toEqual([]);
  tree.calls.length = 0;
  fake.push(
    ServerMessage.parse({
      type: "events",
      subscriptionId: "s",
      afterSeq: 0,
      throughSeq: 1,
      events: [
        {
          seq: 1,
          id: "e1",
          at: 0,
          threadId: thread,
          payload: {
            type: "workspace.files_changed",
            workspaceId: "ace",
            change: { id: "c1", op: "write", path: "docs/a.md", version: null },
          },
        },
      ],
    }),
  );
  expect(tree.folders()).toEqual([]);
  timers.fire();
  await settle();
  expect(tree.folders()).toEqual(["", "docs"]);
});
