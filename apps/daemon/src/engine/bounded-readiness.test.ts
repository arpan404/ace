import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadState } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { Store, createDevThread } from "@ace/daemon";
import { EngineRepository } from "./repository.ts";
import { TransitionReadiness } from "./transition-readiness.ts";

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
  return { store, repo, workspace };
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

  let fail = false;
  const store2 = {
    atomic: (run: (db: import("node:sqlite").DatabaseSync) => unknown, outcome?: object) =>
      store.atomic(
        (db) => {
          if (fail) throw new Error("step failed");
          return run(db);
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
