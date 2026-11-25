import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadState } from "@ace/core";
import { AgentId, Command, RunId, ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { Store, createDevThread } from "@ace/daemon";
import { EngineRepository } from "./repository.ts";
import { TransitionReadiness } from "./transition-readiness.ts";
import { changeEngineWorkspace } from "./workspace-change.ts";
import { createEngineThread } from "./create-thread.ts";
import { acceptTransition } from "./transition-handler.ts";
import { AdapterRegistry } from "./registry.ts";

/**
 * Readiness is trusted only once a thread's bounded rebuild has committed this boot (ADR 0170):
 * until then the thread reads as not ready, never as done, and a rollback redoes the step.
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

/** Steps the rebuild until it commits, and says how many steps that took. */
function drain(readiness: TransitionReadiness, id: ThreadId): number {
  let steps = 0;
  while (!readiness.rebuilt(id) && steps < 64) {
    readiness.step();
    steps++;
  }
  return steps;
}

function seedRecords(
  store: ReturnType<typeof open>["store"],
  threadId: ThreadId,
  records: { key: string; value: unknown }[],
) {
  store.atomic((db) => {
    const insert = db.prepare(
      "INSERT INTO engine_state_records(thread_id,section,key,value) VALUES (?, 'agents', ?, ?)",
    );
    for (const record of records) insert.run(threadId, record.key, JSON.stringify(record.value));
  });
}

test("a thread is not reported ready until its rebuild commits, then it is", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(store, thread.id, [{ key: "root", value: agentRecord(thread.id, "root", "idle") }]);

  // The engine starts the pass after construction; until the rebuild commits, not ready.
  repo.readiness.start();
  expect(repo.readiness.rebuilt(thread.id)).toBe(false);
  expect(repo.quiescent(state)).toBe(false);
  expect(repo.acceptsPersonInput(state)).toBe(false);

  // Discovery, the clear step, then the agent records: the idle root leaves no blocker.
  drain(repo.readiness, thread.id);
  expect(repo.readiness.rebuilt(thread.id)).toBe(true);
  expect(repo.quiescent(state)).toBe(true);
  expect(repo.acceptsPersonInput(state)).toBe(true);
});

test("a thread blocked at the last stop is not reported ready before its rebuild commits", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(store, thread.id, [
    { key: "root", value: agentRecord(thread.id, "root", "working") },
  ]);

  repo.readiness.start();
  expect(repo.quiescent(state)).toBe(false);
  drain(repo.readiness, thread.id);
  expect(repo.readiness.rebuilt(thread.id)).toBe(true);
  // Its stored record still says working: the rebuild wrote that blocker, not a stale one.
  expect(repo.quiescent(state)).toBe(false);
});

test("a readiness rebuild rolled back with its transaction leaves the thread not ready, and the redone step marks it rebuilt", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(store, thread.id, [{ key: "root", value: agentRecord(thread.id, "root", "idle") }]);

  // The step's rows are written, then the transaction fails: the rollback must undo them and
  // leave no progress behind.
  let fail = false;
  const store2 = {
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
  const readiness = new TransitionReadiness(store2, () => 1_000);
  readiness.start();
  readiness.request(thread.id);

  fail = true;
  expect(() => readiness.step()).toThrow("step failed");
  expect(readiness.rebuilt(thread.id)).toBe(false);
  // The clear step's write was rolled back with it, so nothing of it remains.
  expect(
    store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM engine_transition_blockers").get()?.n,
    ),
  ).toBe(0);

  fail = false;
  drain(readiness, thread.id);
  expect(readiness.rebuilt(thread.id)).toBe(true);
});

test("a thread with 1,000 agents is rebuilt in at least four bounded steps and reads not ready until the last one commits", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(
    store,
    thread.id,
    Array.from({ length: 1_000 }, (_, index) => ({
      key: `agent-${String(index).padStart(4, "0")}`,
      value: agentRecord(thread.id, String(index), "idle"),
    })),
  );

  repo.readiness.start();
  let steps = 0;
  while (!repo.readiness.rebuilt(thread.id) && steps < 12) {
    repo.readiness.step();
    steps++;
    if (!repo.readiness.rebuilt(thread.id)) expect(repo.quiescent(state)).toBe(false);
  }
  // One step discovers the thread, one clears its blockers, and 256 agents a step are four more.
  expect(steps).toBeGreaterThanOrEqual(4);
  expect(repo.readiness.rebuilt(thread.id)).toBe(true);
  expect(repo.quiescent(state)).toBe(true);
});

test("stale blockers of a thread with no agent records are removed", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  store.atomic((db) =>
    db
      .prepare("INSERT INTO engine_transition_blockers(thread_id,agent_key) VALUES (?,?)")
      .run(thread.id, "stale"),
  );

  repo.readiness.start();
  expect(repo.readiness.rebuilt(thread.id)).toBe(false);
  expect(repo.quiescent(state)).toBe(false);
  drain(repo.readiness, thread.id);
  expect(
    store.atomic((db) => db.prepare("SELECT 1 FROM engine_transition_blockers").get()),
  ).toBeUndefined();
  expect(repo.quiescent(state)).toBe(true);
});

test("the wait a transition makes for a thread not yet rebuilt resolves only once its rebuild commits", async () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(store, thread.id, [{ key: "root", value: agentRecord(thread.id, "root", "idle") }]);

  repo.readiness.start();
  let settled = false;
  const waited = repo.readiness.whenRebuilt(thread.id).then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(repo.readiness.rebuilt(thread.id)).toBe(false);

  drain(repo.readiness, thread.id);
  await waited;
  expect(settled).toBe(true);
  expect(repo.readiness.rebuilt(thread.id)).toBe(true);
});

test("a thread rebuilt this boot is never cleared again by a later discovery page", () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  seedRecords(
    store,
    thread.id,
    Array.from({ length: 200 }, (_, index) => ({
      key: `agent-${String(index).padStart(4, "0")}`,
      value: agentRecord(thread.id, String(index), "working"),
    })),
  );
  const readiness = repo.readiness;
  readiness.start();
  readiness.request(thread.id);
  drain(readiness, thread.id);
  expect(readiness.agentsReady(state)).toBe(false);

  // Discovery still has this thread's agent rows to page through. Clearing it again would drop
  // its blockers while its rebuilt flag still said its blockers were trusted.
  for (let step = 0; step < 8; step++) {
    readiness.step();
    expect(readiness.agentsReady(state)).toBe(false);
  }
  expect(
    store.atomic(
      (db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM engine_transition_blockers WHERE thread_id=?")
          .get(thread.id)?.n,
    ),
  ).toBe(200);
});

test("a rebuild that cannot proceed releases its waiters, and a thread it was part-way through still reads not ready", async () => {
  const { store, repo, workspace } = open();
  const half = (name: string, state: "idle" | "working") => {
    const thread = createDevThread(store, workspace, name, "codex");
    const value = createThreadState({
      threadId: thread.id,
      config: { provider: "codex", silenceMs: 100 },
    });
    repo.save(value, [], 1_000);
    seedRecords(store, thread.id, [{ key: "root", value: agentRecord(thread.id, "root", state) }]);
    return { thread, state: value };
  };
  const part = half("Part-way", "working");
  const untouched = half("Untouched", "idle");

  let armed = false;
  const failing = {
    atomic: (run: (db: DatabaseSync) => unknown, outcome?: object) =>
      store.atomic(
        (db) => {
          const result = run(db);
          if (armed) throw new Error("step failed");
          return result;
        },
        outcome as Parameters<typeof store.atomic>[1],
      ),
    statement: (sql: string) => store.statement(sql),
  } as unknown as Store;
  const readiness = new TransitionReadiness(failing, () => 1_000);
  readiness.start();
  readiness.request(part.thread.id);
  readiness.step(); // clears its blockers, which commits
  armed = true;
  expect(() => readiness.step()).toThrow("step failed");

  let waited = false;
  const waiting = readiness.whenRebuilt(untouched.thread.id).then(() => (waited = true));
  readiness.failed();
  await waiting;
  expect(waited).toBe(true);
  // Untouched, its stored blockers are main's read; the one it was part-way through is not.
  expect(readiness.agentsReady(untouched.state)).toBe(true);
  expect(readiness.agentsReady(part.state)).toBe(false);
});

test("a workspace change fences its roots before it returns, even while readiness warms", async () => {
  const { store, repo, workspace } = open();
  const thread = createDevThread(store, workspace);
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  repo.save(state, [], 1_000);
  repo.createSession(thread.id, workspace);
  // A stored agent record keeps this thread's readiness warming until its rebuild commits.
  seedRecords(store, thread.id, [{ key: "root", value: agentRecord(thread.id, "root", "idle") }]);
  repo.readiness.start();
  expect(repo.readiness.rebuilt(thread.id)).toBe(false);

  const gate = Promise.withResolvers<import("@ace/protocol").ThreadDetails>();
  const change = changeEngineWorkspace(
    repo,
    thread.id,
    "move",
    () => 1_000,
    async () => {},
    () => gate.promise,
    () => {},
    { roots: [workspace], hasOwnedWork: () => false },
  );
  // The fence is committed before the call yields, as main's synchronous admission did.
  expect(
    store.atomic(
      (db) =>
        db
          .prepare("SELECT command_id FROM workspace_root_reservations WHERE thread_id=?")
          .get(thread.id)?.command_id,
    ),
  ).toBe("move");
  expect(repo.transitions.guarded(thread.id)).toBe(true);
  expect(() => store.executionWorkspace(thread.id)).toThrow("workspace_change_in_progress");

  repo.readiness.step(); // discovery, then the clear and the agent records
  repo.readiness.step();
  repo.readiness.step();
  gate.resolve({ mode: "local", worktree: workspace });
  await change;
  expect(store.executionWorkspace(thread.id)).toMatchObject({ path: workspace, ready: true });
  expect(repo.transitions.guarded(thread.id)).toBe(false);
});

test("a merge on an idle thread whose blockers are warming is admitted, as main's open-time rebuild would have let it", () => {
  const { store, workspace, home } = open();
  const parent = ThreadId.parse("merge-parent");
  const fork = ThreadId.parse("merge-fork");
  const first = new EngineRepository(store, undefined, 64, undefined, undefined, () => 1_000);
  const create = (id: ThreadId, lineage?: import("@ace/protocol").ThreadLineage) =>
    createEngineThread(first, {
      id,
      workspaceId: workspace,
      title: id,
      selection: { provider: "codex", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
      ...(lineage ? { lineage } : {}),
    });
  create(parent);
  create(fork, {
    parentThreadId: parent,
    parentAgentId: AgentId.parse("parent-agent"),
    point: { type: "turn", runId: RunId.parse("parent-run") },
    mode: "portable",
    lossy: true,
  });
  // Its stored records are the ones a previous boot left; this boot has not rebuilt them.
  seedRecords(store, fork, [{ key: "root", value: agentRecord(fork, "root", "idle") }]);
  store.atomic((db) =>
    db
      .prepare("INSERT INTO items VALUES (?,?,?,?)")
      .run("cite-1", fork, 1, JSON.stringify({ id: "cite-1", type: "message" })),
  );
  const restarted = new EngineRepository(store, undefined, 64, undefined, undefined, () => 1_000);
  restarted.readiness.start();
  expect(restarted.readiness.rebuilt(fork)).toBe(false);
  expect(restarted.quiescent(restarted.requireState(fork))).toBe(false);

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
  // Main would admit this idle tree; the warming read must not turn it into a wrong refusal.
  expect(
    acceptTransition(
      restarted,
      new AdapterRegistry(),
      command,
      1_000,
      () => "next-id",
      () => {},
    ),
  ).toMatchObject({ ok: true });

  drain(restarted.readiness, fork);
  expect(restarted.readiness.rebuilt(fork)).toBe(true);
  expect(restarted.quiescent(restarted.requireState(fork))).toBe(true);
});
