import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { childTreeRoot, originTreeRoot, remoteChildTreeRoot } from "./tree-root.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function openStore() {
  const home = mkdtempSync(join(tmpdir(), "ace-tree-root-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, "events.sqlite");
  let store = new Store(dbPath);
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return {
    get store() {
      return store;
    },
    workspace,
    reopen() {
      store.close();
      store = new Store(dbPath);
    },
  };
}

function createDelegatedTable(store: Store) {
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS delegated_threads (
      child_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      root_id TEXT NOT NULL
    )`),
  );
}

function addDelegationEdge(store: Store, childId: ThreadId, parentId: ThreadId, rootId: ThreadId) {
  createDelegatedTable(store);
  store.atomic((db) =>
    db
      .prepare("INSERT OR REPLACE INTO delegated_threads (child_id, parent_id, root_id) VALUES (?,?,?)")
      .run(childId, parentId, rootId),
  );
}

it("computes child, origin, and remote tree roots while never treating a host thread as a root", () => {
  const main = ThreadId.parse("t-main");
  const child = ThreadId.parse("t-child");
  const remoteChild = ThreadId.parse("t-remote");
  const spade = ThreadId.parse("t-spade");

  expect(childTreeRoot(undefined)).toBeUndefined();
  expect(childTreeRoot({ id: main })).toBe(main);
  expect(childTreeRoot({ id: child, treeRootId: main })).toBe(main);
  expect(childTreeRoot({ id: spade, host: "spade" })).toBeUndefined();

  expect(originTreeRoot({ id: main }, main)).toBe(main);
  expect(originTreeRoot({ id: child, treeRootId: main }, child)).toBe(main);
  expect(originTreeRoot({ id: spade, host: "spade" }, spade)).toBeNull();

  expect(remoteChildTreeRoot({ threadId: child, rootThreadId: main }, remoteChild)).toBe(main);
  expect(remoteChildTreeRoot({ threadId: child }, remoteChild)).toBe(child);
  expect(remoteChildTreeRoot({ threadId: spade, rootThreadId: null }, remoteChild)).toBe(
    remoteChild,
  );
});

it("lazily resolves treeRootId for stored pre-upgrade threads across delegation, handoff, thread_start, and paired machines", () => {
  const h = openStore();
  const main = createDevThread(h.store, h.workspace).id;
  const child = createDevThread(h.store, h.workspace).id;
  const grandchild = createDevThread(h.store, h.workspace).id;
  const handoff = createDevThread(h.store, h.workspace).id;
  const started = createDevThread(h.store, h.workspace).id;
  const remote = createDevThread(h.store, h.workspace).id;
  const remoteLocalChild = createDevThread(h.store, h.workspace).id;

  // Pre-upgrade rows have edges (delegated_threads, delegatedBy, startedBy, delegatedFrom)
  // without treeRootId stored in transitions.
  h.store.appendEvents(child, [{ type: "thread.updated", delegatedBy: main }]);
  h.store.appendEvents(grandchild, [{ type: "thread.updated", delegatedBy: child }]);
  addDelegationEdge(h.store, child, main, main);
  addDelegationEdge(h.store, grandchild, child, main);
  // Handoff/automation child has only its delegated_threads edge and no delegatedBy.
  addDelegationEdge(h.store, handoff, child, main);
  // thread_start child started by a delegated child carries only startedBy.
  h.store.appendEvents(started, [{ type: "thread.updated", startedBy: child }]);
  // Paired-machine child from before treeRootId carries only delegatedFrom.
  const remoteRoot = ThreadId.parse("remote-root");
  const remoteParent = ThreadId.parse("remote-parent");
  h.store.appendEvents(remote, [
    {
      type: "thread.updated",
      delegatedFrom: {
        hostId: HostId.parse("peer-host"),
        threadId: remoteParent,
        rootThreadId: remoteRoot,
      },
    },
  ]);
  addDelegationEdge(h.store, remoteLocalChild, remote, remote);

  h.reopen();

  // A person's own thread stays its own root (no treeRootId).
  expect(h.store.getThread(main)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(child)?.treeRootId).toBe(main);
  expect(h.store.getThread(grandchild)?.treeRootId).toBe(main);
  expect(h.store.getThread(handoff)?.treeRootId).toBe(main);
  expect(h.store.getThread(started)?.treeRootId).toBe(main);
  expect(h.store.getThread(remote)?.treeRootId).toBe(remoteRoot);
  expect(h.store.getThread(remoteLocalChild)?.treeRootId).toBe(remoteRoot);
  // listThreads and sidebarPage also expose the resolved treeRootId.
  const listed = new Map(h.store.listThreads().map((thread) => [thread.id, thread.treeRootId]));
  expect(listed.get(main)).toBeUndefined();
  expect(listed.get(handoff)).toBe(main);
  expect(listed.get(started)).toBe(main);
  const page = new Map(
    h.store.sidebarPage({ limit: 50 }).threads.map((thread) => [thread.id, thread.treeRootId]),
  );
  expect(page.get(started)).toBe(main);
  expect(page.get(handoff)).toBe(main);
});

it("never resolves a hidden Spade host thread as a tree root on pre-upgrade rows", () => {
  const h = openStore();
  const host = createDevThread(h.store, h.workspace).id;
  const direct = createDevThread(h.store, h.workspace).id;
  const grandchild = createDevThread(h.store, h.workspace).id;
  const startedByHost = createDevThread(h.store, h.workspace).id;

  h.store.appendEvents(host, [{ type: "thread.client.updated", changes: { host: "spade" } }]);
  h.store.appendEvents(direct, [{ type: "thread.updated", delegatedBy: host }]);
  h.store.appendEvents(grandchild, [{ type: "thread.updated", delegatedBy: direct }]);
  h.store.appendEvents(startedByHost, [{ type: "thread.updated", startedBy: host }]);
  addDelegationEdge(h.store, direct, host, host);
  addDelegationEdge(h.store, grandchild, direct, host);

  h.reopen();

  expect(h.store.getThread(host)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(direct)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(grandchild)?.treeRootId).toBe(direct);
  expect(h.store.getThread(startedByHost)?.treeRootId).toBeUndefined();
});

it("handles a stored cycle without looping forever", () => {
  const h = openStore();
  const a = createDevThread(h.store, h.workspace).id;
  const b = createDevThread(h.store, h.workspace).id;
  h.store.appendEvents(a, [{ type: "thread.updated", startedBy: b }]);
  h.store.appendEvents(b, [{ type: "thread.updated", startedBy: a }]);

  h.reopen();

  expect(h.store.getThread(a)?.treeRootId).toBe(b);
  expect(h.store.getThread(b)?.treeRootId).toBe(a);
});
