import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId, DelegationRecord, HostId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { DelegationJournal } from "./agent-control/journal.ts";
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
  let journal = new DelegationJournal(store);
  store.bindDelegationJournal(journal);
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return {
    get store() {
      return store;
    },
    get journal() {
      return journal;
    },
    workspace,
    reopen() {
      store.close();
      store = new Store(dbPath);
      journal = new DelegationJournal(store);
      store.bindDelegationJournal(journal);
    },
  };
}

function recordDelegation(
  store: Store,
  journal: DelegationJournal,
  childId: ThreadId,
  parentId: ThreadId,
  rootId: ThreadId,
  depth = 1,
) {
  const record = DelegationRecord.parse({
    childId,
    parentId,
    parentAgentId: AgentId.parse("parent-agent"),
    rootId,
    requestId: `req-${childId}`,
    request: {
      requestId: `req-${childId}`,
      role: "Worker",
      task: "Do work",
      provider: "codex",
    },
    depth,
    createdAt: 1,
    phase: "settled",
    generation: 0,
  });
  store.atomic(() => {
    journal.tree(rootId, 1);
    journal.reserve({ record });
    journal.add(record);
  });
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

it("lazily resolves treeRootId when loading stored pre-upgrade threads without resolving bulk listThreads", () => {
  const h = openStore();
  const main = createDevThread(h.store, h.workspace).id;
  const child = createDevThread(h.store, h.workspace).id;
  const grandchild = createDevThread(h.store, h.workspace).id;
  const handoff = createDevThread(h.store, h.workspace).id;
  const started = createDevThread(h.store, h.workspace).id;
  const remote = createDevThread(h.store, h.workspace).id;
  const remoteLocalChild = createDevThread(h.store, h.workspace).id;

  // Pre-upgrade rows have edges (delegation journal, delegatedBy, startedBy, delegatedFrom)
  // without treeRootId stored in transitions.
  h.store.appendEvents(child, [{ type: "thread.updated", delegatedBy: main }]);
  h.store.appendEvents(grandchild, [{ type: "thread.updated", delegatedBy: child }]);
  recordDelegation(h.store, h.journal, child, main, main, 1);
  recordDelegation(h.store, h.journal, grandchild, child, main, 2);
  // Handoff/automation child has only its delegation journal edge and no delegatedBy.
  recordDelegation(h.store, h.journal, handoff, child, main, 2);
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
  recordDelegation(h.store, h.journal, remoteLocalChild, remote, remote, 1);

  h.reopen();

  // Bulk listThreads must not walk history for pre-upgrade rows (ADR 0170).
  const listed = new Map(h.store.listThreads().map((thread) => [thread.id, thread.treeRootId]));
  expect(listed.get(main)).toBeUndefined();
  expect(listed.get(handoff)).toBeUndefined();
  expect(listed.get(started)).toBeUndefined();

  // Loading an individual thread resolves and caches its tree root lazily.
  expect(h.store.getThread(main)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(child)?.treeRootId).toBe(main);
  expect(h.store.getThread(grandchild)?.treeRootId).toBe(main);
  expect(h.store.getThread(handoff)?.treeRootId).toBe(main);
  expect(h.store.acquireThread(started).thread.treeRootId).toBe(main);
  expect(h.store.getThread(remote)?.treeRootId).toBe(remoteRoot);
  expect(h.store.getThread(remoteLocalChild)?.treeRootId).toBe(remoteRoot);
});

it("a stored Spade host parent makes its direct child its own root", () => {
  const h = openStore();
  const host = createDevThread(h.store, h.workspace).id;
  const direct = createDevThread(h.store, h.workspace).id;
  const grandchild = createDevThread(h.store, h.workspace).id;
  const startedByHost = createDevThread(h.store, h.workspace).id;

  h.store.appendEvents(host, [{ type: "thread.client.updated", changes: { host: "spade" } }]);
  h.store.appendEvents(direct, [{ type: "thread.updated", delegatedBy: host }]);
  h.store.appendEvents(grandchild, [{ type: "thread.updated", delegatedBy: direct }]);
  h.store.appendEvents(startedByHost, [{ type: "thread.updated", startedBy: host }]);
  recordDelegation(h.store, h.journal, direct, host, host, 1);
  recordDelegation(h.store, h.journal, grandchild, direct, host, 2);

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
  expect(h.store.getThread(b)?.treeRootId ?? b).toBe(b);
});
