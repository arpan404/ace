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
import { CheckoutError } from "@ace/ui-core";
import { expect, test } from "vitest";
import type { TreeOwner } from "./checkout-tree-live.ts";
import { CheckoutTrees, type TreeFiles } from "./checkout-tree-live.ts";
import type { TreeRow } from "./checkout-tree.ts";
import type { FilesScope } from "./checkout-request.ts";
import type { Timers } from "./kept-read.ts";

/*
 * The Files screen's live tree, one folder at a time: the root when it opens, a folder when it
 * becomes visible, pages when Show more asks, and the folders the daemon names listed again.
 * A fake client stands in for the socket so the test sees every `files.watch` and every
 * `files.tree` patch the phone would draw; a fake Files service holds pages and requests open.
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
const noPage = () => page([]);

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

interface Call {
  folder: string;
  cursor: string | undefined;
  limit: number;
  scope: FilesScope;
  signal: AbortSignal;
}

/** `gate` rejects when `signal` aborts, as a real request does. */
function abortable(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

function files() {
  const calls: Call[] = [];
  let contents: (folder: string, cursor: string | undefined) => FolderPage = noPage;
  let marks: readonly GitStatusFile[] = [];
  let failure: ((folder: string, cursor: string | undefined) => unknown) | undefined;
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  let statusGate: Promise<void> | undefined;
  let releaseStatus: (() => void) | undefined;
  const source: TreeFiles = {
    async listFolder(requested, directory, cursor, limit, signal) {
      calls.push({ folder: directory, cursor, limit, scope: requested, signal });
      if (gate) await abortable(gate, signal);
      const failed = failure?.(directory, cursor);
      if (failed !== undefined) throw failed;
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
    setFailure(read: (folder: string, cursor: string | undefined) => unknown) {
      failure = read;
    },
    /** Hold every listing until the returned function is called. */
    hold() {
      gate = new Promise((resolve) => {
        openGate = resolve;
      });
      return () => {
        gate = undefined;
        openGate?.();
      };
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
    callsFor: (name: string) => calls.filter((call) => call.folder === name),
  };
}

function screen() {
  const patches: Patch[] = [];
  const reads: (() => Patch | undefined)[] = [];
  return {
    patches,
    put: (_key: string, read: () => Patch | undefined) => {
      reads.push(read);
      const value = read();
      if (value) patches.push(value);
    },
    last: () => patches.at(-1),
    /** The closure of the last patch, as the pump would call it later. */
    lastRead: () => reads.at(-1),
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
  for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const rowsOf = (patch: Patch | undefined): TreeRow[] => (patch?.rows ?? []) as TreeRow[];
const keys = (patch: Patch | undefined) => rowsOf(patch).map((row) => row.key);
const watches = (sent: Sent[]) =>
  sent.filter((message) => message.type === "files.watch").map((message) => message.folders);

function opened(options: { requestLimit?: number } = {}) {
  const fake = client();
  const tree = files();
  const view = screen();
  const timers = handTimers();
  const trees = new CheckoutTrees(fake.owner, tree.source, view, timers, options);
  return { fake, tree, view, timers, trees };
}

const threadChanged = (path: string, destination?: string) =>
  FilesServerMessage.parse({
    type: "files.changed",
    change: {
      id: "c1",
      op: destination === undefined ? "write" : "move",
      path,
      version: null,
      ...(destination === undefined ? {} : { destination }),
    },
  });

const projectChanged = (workspaceId: string, path: string) =>
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
          workspaceId,
          change: { id: "c1", op: "write", path, version: null },
        },
      },
    ],
  });

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
  expect(tree.calls[0]?.limit).toBe(500);
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
  expect(tree.calls.at(-1)).toMatchObject({ folder: "", cursor: "two", limit: 500 });
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
  expect(tree.folders()).toEqual(["", "docs", "src"]);
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

test("showing twice and hiding once keeps the tree and its watch set", async () => {
  const { fake, tree, timers, trees } = opened();
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  const listed = tree.calls.length;
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.calls.length).toBe(listed);
  timers.fire();
  fake.sent.length = 0;
  trees.handle({ type: "files.tree.hide", scope });
  expect(watches(fake.sent)).toEqual([]);
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
  expect(keys(view.last())).toContain(outbox);
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

test("a re-list asks for the pages the folder already shows", async () => {
  const { tree, trees } = opened();
  const shown = Array.from({ length: 700 }, (_, n) => entry(`f${n}.ts`));
  tree.setPages(() => page(shown));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.refresh", scope });
  await settle();
  expect(tree.callsFor("").at(-1)?.limit).toBe(700);
});

test("a change while a folder is being listed re-lists it once when the page arrives", async () => {
  const { fake, tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([entry("a.ts")]) : page([])));
  const release = tree.hold();
  trees.handle({ type: "files.tree.show", scope });
  for (let at = 0; at < 5; at++)
    fake.push(
      FilesServerMessage.parse({
        type: "files.folders_changed",
        threadId: thread,
        folders: [""],
        rescan: false,
      }),
    );
  trees.handle({ type: "files.tree.refresh", scope });
  await settle();
  expect(tree.callsFor("")).toHaveLength(1);
  release();
  await settle();
  expect(tree.callsFor("")).toHaveLength(2);
});

test("a short hide re-lists only the folders that changed, at their loaded size", async () => {
  const { fake, tree, trees } = opened();
  const shown = Array.from({ length: 700 }, (_, n) => entry(`src/f${n}.ts`));
  tree.setPages((path) => (path === "" ? page([folder("src")]) : page(shown)));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  await settle();
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.hide", scope });
  fake.push(threadChanged("src/new.ts"));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.folders()).toEqual(["src"]);
  expect(tree.callsFor("src").at(-1)?.limit).toBe(700);
});

test("showing a tree again with nothing stale lists nothing", async () => {
  const { tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("src")]) : page([entry("src/a.ts")])));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  await settle();
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.hide", scope });
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.folders()).toEqual([]);
});

test("a long hide lists the visible folders again", async () => {
  const { tree, timers, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("src")]) : page([entry("src/a.ts")])));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  await settle();
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.hide", scope });
  timers.fire();
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.folders()).toEqual(["", "src"]);
});

test("a folder under a folded parent is not listed, watched or re-listed", async () => {
  const { fake, tree, timers, trees } = opened();
  tree.setPages((path) => {
    const pages: Record<string, FolderEntry[]> = {
      "": [folder("apps")],
      apps: [folder("apps/web")],
      "apps/web": [entry("apps/web/a.ts")],
    };
    return page(pages[path] ?? []);
  });
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "apps/" });
  trees.handle({ type: "files.tree.opened", scope, path: "apps/web/" });
  await settle();
  trees.handle({ type: "files.tree.closed", scope, path: "apps/" });
  tree.calls.length = 0;
  fake.sent.length = 0;
  timers.fire();
  expect(watches(fake.sent)).toEqual([[""]]);
  fake.push(
    FilesServerMessage.parse({
      type: "files.folders_changed",
      threadId: thread,
      folders: ["apps/web"],
      rescan: false,
    }),
  );
  fake.push(
    FilesServerMessage.parse({
      type: "files.folders_changed",
      threadId: thread,
      folders: [],
      rescan: true,
    }),
  );
  await settle();
  expect(tree.folders()).toEqual([""]);
});

test("a folder that becomes visible again is listed", async () => {
  const { tree, trees } = opened();
  tree.setPages((path) => {
    const pages: Record<string, FolderEntry[]> = {
      "": [folder("apps")],
      apps: [folder("apps/web")],
      "apps/web": [entry("apps/web/a.ts")],
    };
    return page(pages[path] ?? []);
  });
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "apps/" });
  trees.handle({ type: "files.tree.opened", scope, path: "apps/web/" });
  await settle();
  trees.handle({ type: "files.tree.closed", scope, path: "apps/" });
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.opened", scope, path: "apps/" });
  await settle();
  expect(tree.folders()).toEqual(["apps", "apps/web"]);
});

test("at most four folder listings are in flight", async () => {
  const { tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("a")]) : page([entry(`${path}/x.ts`)])));
  const release = tree.hold();
  trees.handle({ type: "files.tree.show", scope });
  for (const path of ["a/", "b/", "c/", "d/", "e/"])
    trees.handle({ type: "files.tree.opened", scope, path });
  await settle();
  expect(tree.calls).toHaveLength(4);
  release();
  await settle();
  expect(tree.calls).toHaveLength(6);
});

test("the request cap is injected for tests", async () => {
  const { tree, trees } = opened({ requestLimit: 2 });
  tree.setPages((path) => (path === "" ? page([folder("a")]) : page([entry(`${path}/x.ts`)])));
  const release = tree.hold();
  trees.handle({ type: "files.tree.show", scope });
  for (const path of ["a/", "b/", "c/", "d/"])
    trees.handle({ type: "files.tree.opened", scope, path });
  await settle();
  expect(tree.calls).toHaveLength(2);
  release();
  await settle();
  expect(tree.calls).toHaveLength(5);
});

test("pending requests start with the root and shallower folders first", async () => {
  const { tree, trees } = opened({ requestLimit: 2 });
  tree.setPages((path) => (path === "" ? page([folder("src"), folder("docs")]) : page([])));
  const release = tree.hold();
  trees.handle({ type: "files.tree.show", scope });
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  trees.handle({ type: "files.tree.opened", scope, path: "src/lib/" });
  trees.handle({ type: "files.tree.opened", scope, path: "docs/" });
  await settle();
  expect(tree.folders()).toEqual(["", "src"]);
  release();
  await settle();
  expect(tree.folders()).toEqual(["", "src", "docs", "src/lib"]);
});

test("retrying a failed Show more asks for that page again", async () => {
  const { tree, view, trees } = opened();
  tree.setPages((path, cursor) =>
    path === "" && cursor === undefined ? page([entry("a.ts")], "two", 2) : page([entry("b.ts")]),
  );
  let failed = false;
  tree.setFailure((path, cursor) => {
    if (path !== "" || cursor !== "two" || failed) return undefined;
    failed = true;
    return new Error("Couldn't list");
  });
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.more", scope, path: "" });
  await settle();
  expect(rowsOf(view.last()).some((row) => row.kind === "error")).toBe(true);
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.retry", scope, path: "" });
  await settle();
  expect(tree.calls[0]).toMatchObject({ folder: "", cursor: "two" });
  expect(rowsOf(view.last()).some((row) => row.key === "b.ts")).toBe(true);
});

test("a thread change re-lists only its parent folders", async () => {
  const { fake, tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("src"), folder("docs")]) : page([])));
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  trees.handle({ type: "files.tree.opened", scope, path: "src/" });
  trees.handle({ type: "files.tree.opened", scope, path: "docs/" });
  await settle();
  tree.calls.length = 0;
  fake.push(threadChanged("src/a.ts", "docs/a.ts"));
  await settle();
  expect(tree.folders()).toEqual(["docs", "src"]);
});

test("a project tree follows workspace.files_changed, not files.changed", async () => {
  const { fake, tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("docs")]) : page([])));
  trees.handle({ type: "files.tree.show", scope: project });
  await settle();
  trees.handle({ type: "files.tree.opened", scope: project, path: "docs/" });
  await settle();
  tree.calls.length = 0;
  fake.push(threadChanged("docs/a.md"));
  await settle();
  expect(tree.folders()).toEqual([]);
  fake.push(projectChanged("other", "docs/a.md"));
  await settle();
  expect(tree.folders()).toEqual([]);
  fake.push(projectChanged("ace", "docs/a.md"));
  await settle();
  expect(tree.folders()).toEqual(["docs"]);
});

test("losing the connection clears a folder's loading row", async () => {
  const { fake, tree, view, trees } = opened();
  tree.setPages(() => page([entry("a.ts")]));
  const release = tree.hold();
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(keys(view.last())).toEqual(["loading:"]);
  fake.disconnect();
  await settle();
  expect(keys(view.last())).toEqual([]);
  release();
});

test("a second INVALID_CURSOR becomes an ordinary folder error", async () => {
  const { tree, view, trees } = opened();
  tree.setFailure(
    () => new CheckoutError("INVALID_CURSOR", "This folder changed while it was loading."),
  );
  trees.handle({ type: "files.tree.show", scope });
  await settle();
  expect(tree.callsFor("")).toHaveLength(2);
  expect(rowsOf(view.last())).toContainEqual(
    expect.objectContaining({ kind: "error", error: "This folder changed while it was loading." }),
  );
  expect(rowsOf(view.last()).some((row) => row.kind === "loading")).toBe(false);
});

test("pages of a fourth hidden tree are dropped", async () => {
  const { tree, trees } = opened();
  tree.setPages((path) => (path === "" ? page([folder("src")]) : page([entry("src/a.ts")])));
  const scopes = ["t1", "t2", "t3", "t4"].map(
    (id) => ({ threadId: ThreadId.parse(id) }) satisfies FilesScope,
  );
  for (const each of scopes) {
    trees.handle({ type: "files.tree.show", scope: each });
    await settle();
    trees.handle({ type: "files.tree.hide", scope: each });
    await settle();
  }
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.show", scope: { threadId: ThreadId.parse("t1") } });
  await settle();
  expect(tree.folders()).toEqual([""]);
  tree.calls.length = 0;
  trees.handle({ type: "files.tree.show", scope: { threadId: ThreadId.parse("t4") } });
  await settle();
  expect(tree.folders()).toEqual([]);
});

test("rows are built when the patch is pulled, not when the change happens", async () => {
  const { tree, view, trees } = opened();
  tree.setPages(() => page([entry("a.ts")]));
  trees.handle({ type: "files.tree.show", scope });
  const read = view.lastRead();
  expect(read).toBeDefined();
  await settle();
  expect(rowsOf(read?.()).map((row) => row.key)).toEqual(["a.ts"]);
});
