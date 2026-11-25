import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadState } from "@ace/core";
import { AgentId, Command, RunId, Thread, ThreadId, type ThreadDetails } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { Store, createDevThread } from "@ace/daemon";
import { EngineRepository } from "./repository.ts";
import { TransitionReadiness } from "./transition-readiness.ts";
import { changeEngineWorkspace } from "./workspace-change.ts";
import { acceptTransition } from "./transition-handler.ts";
import { AdapterRegistry } from "./registry.ts";
import { SessionRootsFill } from "./fills/session-roots.ts";
import { canonicalRoot } from "../workspace-reservations.ts";

/**
 * A thread's blockers are rebuilt from its own agent rows the first time this boot needs them,
 * inside the caller's transaction (ADR 0170). Nothing trusts a half-rebuilt set: the mark that
 * says "rebuilt" commits with the blockers, and a mark from an earlier boot is not a rebuild.
 */

const opened: { close(): void }[] = [];
afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

function open() {
  const home = mkdtempSync(join(tmpdir(), "ace-bounded-readiness-"));
  const store = new Store(join(home, "events.sqlite"));
  const repo = new EngineRepository(store, undefined, 64, undefined, undefined, () => 1_000);
  opened.push({
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
  const workspace = store.createWorkspace(home, "Workspace");
  return { store, repo, workspace, home };
}

function agentRecord(threadId: ThreadId, key: string, state: "idle" | "working") {
  return {
    agent: {
      id: `agent-${key}`,
      threadId,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/tmp",
      status: state === "idle" ? { state: "idle" } : { state: "working", activity: "thinking" },
      background: false,
      createdAt: 1,
    },
    activity: "thinking",
    lastSignalAt: 1,
  };
}

function seedRecords(store: Store, threadId: ThreadId, records: { key: string; value: unknown }[]) {
  store.atomic((db) => {
    const insert = db.prepare(
      "INSERT INTO engine_state_records(thread_id,section,key,value) VALUES (?, 'agents', ?, ?)",
    );
    for (const record of records) insert.run(threadId, record.key, JSON.stringify(record.value));
  });
}

function lineageTo(parent: ThreadId): import("@ace/protocol").ThreadLineage {
  return {
    parentThreadId: parent,
    parentAgentId: AgentId.parse("parent-agent"),
    point: { type: "turn", runId: RunId.parse("parent-run") },
    mode: "portable",
    lossy: true,
  };
}

function seedItem(store: Store, threadId: ThreadId, id: string) {
  store.atomic((db) =>
    db
      .prepare("INSERT INTO items VALUES (?,?,?,?)")
      .run(id, threadId, 1, JSON.stringify({ id, type: "message" })),
  );
}

/** A thread with engine state but no `thread.created` capture: its records are another boot's. */
function seedThread(
  store: Store,
  repo: EngineRepository,
  workspace: import("@ace/protocol").WorkspaceId,
  id: ThreadId = createDevThread(store, workspace).id,
  lineage?: import("@ace/protocol").ThreadLineage,
) {
  if (!store.getThread(id)) {
    const thread = Thread.parse({
      id,
      workspaceId: workspace,
      title: id,
      provider: "codex",
      hasSentMessage: false,
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
      ...(lineage ? { lineage } : {}),
    });
    store.appendEvents(id, [{ type: "thread.created", thread }], 1);
  }
  const state = createThreadState({ threadId: id, config: { provider: "codex", silenceMs: 100 } });
  repo.save(state, [], 1_000);
  return { thread: store.getThread(id), state };
}

function blockers(store: Store): number {
  return Number(
    store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM engine_transition_blockers").get()?.n,
    ),
  );
}

test("a thread's blockers are rebuilt from its own agent rows the first time a reader asks", () => {
  const { store, repo, workspace } = open();
  const { state } = seedThread(store, repo, workspace);
  seedRecords(store, state.threadId, [
    { key: "root", value: agentRecord(state.threadId, "root", "working") },
  ]);
  expect(blockers(store)).toBe(0);

  // No fill ran: the answer is still main's, because the rebuild happens inside this read.
  expect(repo.quiescent(state)).toBe(false);
  expect(blockers(store)).toBe(1);
  const marks = store.atomic((db) =>
    db.prepare("SELECT boot FROM engine_readiness_rebuilt WHERE thread_id=?").all(state.threadId),
  );
  expect(marks).toHaveLength(1);
});

test("a thread with 1,000 agents is rebuilt in one on-demand step of its own rows, and reads not ready", () => {
  const { store, repo, workspace } = open();
  const { state } = seedThread(store, repo, workspace);
  seedRecords(
    store,
    state.threadId,
    Array.from({ length: 1_000 }, (_, index) => ({
      key: `agent-${String(index).padStart(4, "0")}`,
      value: agentRecord(state.threadId, String(index), "working"),
    })),
  );
  expect(repo.quiescent(state)).toBe(false);
  expect(blockers(store)).toBe(1_000);
});

test("a rebuild rolled back with its transaction leaves no mark and its cleared blockers, and the redone rebuild marks it", () => {
  const { store, repo, workspace } = open();
  const { state } = seedThread(store, repo, workspace);
  seedRecords(store, state.threadId, [
    { key: "root", value: agentRecord(state.threadId, "root", "working") },
  ]);
  store.atomic((db) =>
    db
      .prepare("INSERT INTO engine_transition_blockers(thread_id,agent_key) VALUES (?,?)")
      .run(state.threadId, "stale"),
  );

  // The step's rows are written, then the transaction fails: the mark must not survive it.
  let fail = false;
  const failing = {
    atomic: (run: (db: DatabaseSync) => unknown, outcome?: object) =>
      store.atomic(
        (db) => {
          const result = run(db);
          if (fail) throw new Error("step failed");
          return result;
        },
        outcome as Parameters<typeof store.atomic>[1],
      ),
    statement: (sql: string) => store.statement(sql),
  } as unknown as Store;
  const readiness = new TransitionReadiness(failing, () => 1_000, "boot-two");
  fail = true;
  expect(() => readiness.ensureRebuilt(state.threadId)).toThrow("step failed");
  expect(readiness.rebuilt(state.threadId)).toBe(false);
  expect(
    store.atomic((db) =>
      db
        .prepare("SELECT 1 FROM engine_transition_blockers WHERE thread_id=? AND agent_key='stale'")
        .get(state.threadId),
    ),
  ).toBeDefined();

  fail = false;
  readiness.ensureRebuilt(state.threadId);
  expect(readiness.rebuilt(state.threadId)).toBe(true);
  expect(blockers(store)).toBe(1);
});

test("stale blockers of a thread with no agent records are removed when it is rebuilt", () => {
  const { store, repo, workspace } = open();
  const { state } = seedThread(store, repo, workspace);
  store.atomic((db) =>
    db
      .prepare("INSERT INTO engine_transition_blockers(thread_id,agent_key) VALUES (?,?)")
      .run(state.threadId, "stale"),
  );
  expect(repo.quiescent(state)).toBe(true);
  expect(blockers(store)).toBe(0);
});

test("a crash after a partial rebuild leaves no current-boot mark, so the next boot rebuilds and never reads ready while an agent works", () => {
  const { store, repo, workspace } = open();
  const { state } = seedThread(store, repo, workspace);
  seedRecords(store, state.threadId, [
    { key: "root", value: agentRecord(state.threadId, "root", "working") },
  ]);
  // The crash left the blockers cleared and a mark from another boot behind.
  store.atomic((db) =>
    db
      .prepare("INSERT INTO engine_readiness_rebuilt(thread_id,boot) VALUES (?,?)")
      .run(state.threadId, "old-boot"),
  );
  expect(blockers(store)).toBe(0);

  const next = new EngineRepository(store, undefined, 64, undefined, undefined, () => 2_000);
  expect(next.quiescent(next.requireState(state.threadId))).toBe(false);
  expect(blockers(store)).toBe(1);
  const boot = store.atomic(
    (db) =>
      db.prepare("SELECT boot FROM engine_readiness_rebuilt WHERE thread_id=?").get(state.threadId)
        ?.boot,
  );
  expect(boot).not.toBe("old-boot");
});

test("a merge from a live fork is refused before the rebuild has run, as on main", () => {
  const { store, repo, workspace } = open();
  const parent = ThreadId.parse("merge-parent");
  const fork = ThreadId.parse("merge-fork");
  seedThread(store, repo, workspace, parent);
  seedThread(store, repo, workspace, fork, lineageTo(parent));
  seedItem(store, fork, "cite-1");
  seedRecords(store, fork, [{ key: "root", value: agentRecord(fork, "root", "working") }]);

  const command = Command.parse({
    id: "merge-command",
    deviceId: "device",
    payload: {
      type: "thread.merge",
      threadId: fork,
      summary: "Merged",
      citations: [{ threadId: fork, itemId: "cite-1" }],
    },
  });
  expect(
    acceptTransition(
      repo,
      new AdapterRegistry(),
      command,
      1_000,
      () => "next-id",
      () => {},
    ),
  ).toMatchObject({ ok: false, error: "fork_tree_is_live" });
});

test("a merge from an idle fork is admitted, as on main", () => {
  const { store, repo, workspace } = open();
  const parent = ThreadId.parse("idle-parent");
  const fork = ThreadId.parse("idle-fork");
  seedThread(store, repo, workspace, parent);
  seedThread(store, repo, workspace, fork, lineageTo(parent));
  seedItem(store, fork, "cite-1");
  seedRecords(store, fork, [{ key: "root", value: agentRecord(fork, "root", "idle") }]);

  const command = Command.parse({
    id: "merge-command",
    deviceId: "device",
    payload: {
      type: "thread.merge",
      threadId: fork,
      summary: "Merged",
      citations: [{ threadId: fork, itemId: "cite-1" }],
    },
  });
  expect(
    acceptTransition(
      repo,
      new AdapterRegistry(),
      command,
      1_000,
      () => "next-id",
      () => {},
    ),
  ).toMatchObject({ ok: true });
});

test("a page of only rebuilt ids continues to the next page", () => {
  const { store, repo, workspace } = open();
  const first = ThreadId.parse("aaa-first");
  const second = ThreadId.parse("zzz-second");
  const one = seedThread(store, repo, workspace, first);
  seedThread(store, repo, workspace, second);
  seedRecords(
    store,
    first,
    Array.from({ length: 128 }, (_, index) => ({
      key: `agent-${String(index).padStart(4, "0")}`,
      value: agentRecord(first, String(index), "idle"),
    })),
  );
  seedRecords(store, second, [{ key: "root", value: agentRecord(second, "root", "idle") }]);
  const readiness = repo.readiness;
  // The first page holds only this thread, already rebuilt: the step must still ask for a tick.
  readiness.ensureRebuilt(first);
  expect(readiness.step()).toBe(true);
  expect(readiness.complete()).toBe(false);
  expect(readiness.rebuilt(second)).toBe(false);
  expect(readiness.step()).toBe(true);
  expect(readiness.rebuilt(second)).toBe(false);
  expect(readiness.step()).toBe(true);
  expect(readiness.rebuilt(second)).toBe(true);
  expect(repo.quiescent(one.state)).toBe(true);
});

test("a workspace change fences at once, then finds a peer stored under another symlink and refuses", async () => {
  const { store, repo, workspace, home } = open();
  const root = join(home, "checkout");
  const alias = join(home, "checkout-alias");
  mkdirSync(root);
  symlinkSync(home, alias, "dir");
  store.createWorkspace(root, "Checkout");
  const mover = seedThread(store, repo, workspace);
  repo.createSession(mover.state.threadId, canonicalRoot(root));
  const peerId = ThreadId.parse("alias-peer");
  seedThread(store, repo, workspace, peerId);
  repo.createSession(peerId, join(alias, "checkout"));
  seedRecords(store, peerId, [{ key: "root", value: agentRecord(peerId, "root", "working") }]);

  // Opening's alias reconciliation is a fill now. The change waits for it before its verdict,
  // and only then can the owner lookup see the canonical path the fill wrote.
  let pending: (() => void) | undefined;
  repo.fills.useSchedule((task) => {
    pending = task;
    return () => {};
  });
  repo.fills.start();
  const change = changeEngineWorkspace(
    repo,
    mover.state.threadId,
    "move",
    () => 1_000,
    async () => {},
    async () => ({ mode: "local", worktree: root }) as ThreadDetails,
    () => {},
    { roots: [root], hasOwnedWork: () => false },
  );
  // The roots are fenced before the call yields.
  expect(store.workspaceReservations.threadReserved(peerId)).toBe(true);
  let settled = false;
  void change.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.resolve();
  // It cannot decide yet: the peer's stored path is still the alias until the fill reaches it.
  expect(settled).toBe(false);
  while (!repo.fills.complete("session-roots") && pending) {
    const tick = pending;
    pending = undefined;
    tick();
    await Promise.resolve();
  }
  expect(repo.session(peerId).cwd).toBe(canonicalRoot(root));
  await expect(change).rejects.toThrow("thread_tree_is_live");
  expect(store.workspaceReservations.threadReserved(peerId)).toBe(false);
});

test("a workspace change refuses an alias peer through the canonicalizing scan when the fill could not run", async () => {
  const { store, repo, workspace, home } = open();
  const root = join(home, "checkout");
  const alias = join(home, "alias-two");
  mkdirSync(root);
  symlinkSync(home, alias, "dir");
  store.createWorkspace(root, "Checkout");
  const mover = seedThread(store, repo, workspace);
  repo.createSession(mover.state.threadId, canonicalRoot(root));
  const peerId = ThreadId.parse("scan-peer");
  seedThread(store, repo, workspace, peerId);
  repo.createSession(peerId, join(alias, "checkout"));
  seedRecords(store, peerId, [{ key: "root", value: agentRecord(peerId, "root", "working") }]);
  // The driver never started here, so `whenComplete` answers false and the scan decides.
  expect(new SessionRootsFill(store).complete()).toBe(false);

  const change = changeEngineWorkspace(
    repo,
    mover.state.threadId,
    "move",
    () => 1_000,
    async () => {},
    async () => ({ mode: "local", worktree: root }) as ThreadDetails,
    () => {},
    { roots: [root], hasOwnedWork: () => false },
  );
  await expect(change).rejects.toThrow("thread_tree_is_live");
});
