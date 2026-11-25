import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { GitError, GitService, type Checkpoint } from "@ace/git";
import { Thread, ThreadId, Run, CommandId, AgentId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const git = promisify(execFile);
/** No gate wait outlives this: a regression fails the test instead of hanging to the suite timeout. */
const GATE_DEADLINE_MS = 5_000;
/** Checkpoint captures held at the git edge, so a test can keep the maintenance pool busy. */
class GatedCheckpoints extends GitService {
  holding = false;
  /** Resumed captures fail instead of running, except this thread's: its refs a test reads. */
  private realThread?: string;
  private failure: "failed" | "quarantined" = "failed";
  private held: Array<{ threadId: string; resolve: () => void }> = [];
  private waits: Array<{ count: number; resolve: () => void }> = [];
  override async createCheckpoint(options: {
    worktree: string;
    threadId: string;
    label: string;
  }): Promise<Checkpoint> {
    // The real thread's captures always run, so its refs are readable while others are parked.
    if (this.holding && this.realThread !== options.threadId)
      await new Promise<void>((resolve) => {
        this.held.push({ threadId: options.threadId, resolve });
        for (const wait of this.waits.filter(({ count }) => this.held.length >= count)) {
          this.waits = this.waits.filter((candidate) => candidate !== wait);
          wait.resolve();
        }
      });
    if (this.realThread !== undefined && this.realThread !== options.threadId)
      throw this.failure === "quarantined"
        ? new GitError("git_quarantined", "fixture capture quarantine")
        : new GitError("git_failed", "fixture capture failure");
    return super.createCheckpoint(options);
  }
  /**
   * Every held capture but this thread's will fail when resumed. Failing frees a pool slot the
   * way a failed snapshot does, without taking one real snapshot per parked turn.
   */
  failCapturesOtherThan(threadId: string): void {
    this.realThread = threadId;
    this.failure = "failed";
  }
  /** As `failCapturesOtherThan`, with the failure an admission refuses to run behind. */
  quarantineCapturesOtherThan(threadId: string): void {
    this.realThread = threadId;
    this.failure = "quarantined";
  }
  waitFor(count: number): Promise<void> {
    if (this.held.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.waits = this.waits.filter((candidate) => candidate !== wait);
        reject(
          new Error(
            `gate waited ${GATE_DEADLINE_MS} ms for ${count} held captures, saw ${this.held.length}`,
          ),
        );
      }, GATE_DEADLINE_MS);
      const wait = {
        count,
        resolve: () => {
          clearTimeout(deadline);
          resolve();
        },
      };
      this.waits.push(wait);
    });
  }
  releaseThread(threadId: string): void {
    const index = this.held.findIndex((entry) => entry.threadId === threadId);
    if (index >= 0) this.held.splice(index, 1)[0]?.resolve();
  }
  releaseAll(): void {
    for (let i = 0; i < 100 && this.held.length > 0; i++) this.held.shift()?.resolve();
  }
  /**
   * Stops gating and lets every held capture go. Teardown calls this first so nothing it awaits
   * can still be parked on the gate.
   */
  reopen(): void {
    this.holding = false;
    for (const wait of this.waits.splice(0)) wait.resolve();
    for (const entry of this.held.splice(0)) entry.resolve();
  }
}
/** A root turn of `threadId`; the test names them so the store paginates them. */
const rootTurn = (threadId: string, id: string) =>
  Run.parse({
    id,
    threadId,
    agentId: AgentId.parse("root"),
    trigger: "user",
    state: "active",
    startedAt: 1,
  });
test("turn checkpoint refs bracket actual edits and paged turn numbers survive a cold store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-run-checkpoints-"));
  await git("git", ["init", root]);
  await git("git", ["-C", root, "config", "user.name", "ace test"]);
  await git("git", ["-C", root, "config", "user.email", "test@ace.local"]);
  await writeFile(join(root, "file.txt"), "before\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", ["-C", root, "commit", "-m", "Initial"]);
  // Database is outside the worktree so snapshots never include their own WAL writes.
  const data = await mkdtemp(join(tmpdir(), "ace-run-store-"));
  const path = join(data, "events.sqlite");
  const store = new Store(path);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    rootAgentId: "root",
    title: "Edit",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, data, () => 1000);
  try {
    await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("first"));
    const run = Run.parse({
      id: "turn-one",
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      trigger: "user",
      state: "active",
      startedAt: 1,
    });
    store.appendEvents(thread.id, [
      { type: "run.started", run },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    await writeFile(join(root, "file.txt"), "after\n");
    store.appendEvents(thread.id, [
      { type: "run.ended", runId: run.id, state: "completed", endedAt: 2 },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    await runtime.checkpoints.settled();
    const page = (
      await runtime.read({
        type: "workspace.request",
        requestId: "runs",
        operation: {
          op: "runs.list",
          threadId: thread.id,
          before: Number.MAX_SAFE_INTEGER,
          limit: 1,
        },
      })
    ).result;
    if (page.kind !== "runs") throw new Error("Expected runs");
    expect(page.total).toBe(1);
    const turn = page.runs[0];
    expect(turn?.ordinal).toBe(1);
    expect(turn?.checkpoints?.state).toBe("ready");
    if (!turn?.checkpoints?.before || !turn.checkpoints.after)
      throw new Error("Expected checkpoint refs");
    const diff = await runtime.git.diff({
      worktree: root,
      from: { kind: "checkpoint", id: turn.checkpoints.before },
      to: { kind: "checkpoint", id: turn.checkpoints.after },
    });
    expect(diff.patch).toContain("-before");
    expect(diff.patch).toContain("+after");
    const cold = new Store(path);
    try {
      expect(cold.snapshotThread(thread.id).runs[run.id]).toMatchObject({
        ordinal: 1,
        checkpoints: turn.checkpoints,
      });
    } finally {
      cold.close();
    }
  } finally {
    await runtime.close();
    store.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("root-turn pagination reaches beyond the transcript window and child turns never renumber it", async () => {
  const data = await mkdtemp(join(tmpdir(), "ace-turn-pages-"));
  const store = new Store(join(data, "events.sqlite"));
  const workspaceId = store.createWorkspace(data, "History");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    rootAgentId: "root",
    title: "History",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, data, () => 1000);
  try {
    for (let i = 1; i <= 205; i++) {
      for (const agent of ["root", "child"])
        store.appendEvents(thread.id, [
          {
            type: "run.started",
            run: Run.parse({
              id: `${agent}-${i}`,
              threadId: thread.id,
              agentId: agent,
              trigger: "user",
              state: "active",
              startedAt: i,
            }),
          },
        ]);
    }
    const latest = (
      await runtime.read({
        type: "workspace.request",
        requestId: "latest",
        operation: {
          op: "runs.list",
          threadId: thread.id,
          before: Number.MAX_SAFE_INTEGER,
          limit: 100,
        },
      })
    ).result;
    if (latest.kind !== "runs") throw new Error("Expected runs");
    expect(latest.total).toBe(205);
    expect(latest.runs[0]?.ordinal).toBe(205);
    expect(latest.nextBefore).toBe(106);
    const oldest = (
      await runtime.read({
        type: "workspace.request",
        requestId: "oldest",
        operation: { op: "runs.list", threadId: thread.id, before: 6, limit: 100 },
      })
    ).result;
    if (oldest.kind !== "runs") throw new Error("Expected runs");
    expect(oldest.runs.map((run) => [run.id, run.ordinal])).toEqual([
      ["root-5", 5],
      ["root-4", 4],
      ["root-3", 3],
      ["root-2", 2],
      ["root-1", 1],
    ]);
  } finally {
    await runtime.close();
    await store.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("a message sent right after a turn ends starts its turn from the checkpoint that ended the last one", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-run-boundary-"));
  await git("git", ["init", root]);
  await git("git", ["-C", root, "config", "user.name", "ace test"]);
  await git("git", ["-C", root, "config", "user.email", "test@ace.local"]);
  await writeFile(join(root, "file.txt"), "before\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", ["-C", root, "commit", "-m", "Initial"]);
  const data = await mkdtemp(join(tmpdir(), "ace-run-store-"));
  const store = new Store(join(data, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    rootAgentId: "root",
    title: "Follow up",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, data, () => 1000);
  const turn = (id: string, startedAt: number) =>
    Run.parse({
      id,
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      trigger: "user",
      state: "active",
      startedAt,
    });
  const runs = async (limit: number) => {
    const page = (
      await runtime.read({
        type: "workspace.request",
        requestId: "runs",
        operation: {
          op: "runs.list",
          threadId: thread.id,
          before: Number.MAX_SAFE_INTEGER,
          limit,
        },
      })
    ).result;
    if (page.kind !== "runs") throw new Error("Expected runs");
    return page.runs;
  };
  try {
    // The first message of a thread has no "after" waiting, so it takes its own "before".
    await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("first"));
    const first = turn("turn-one", 1);
    store.appendEvents(thread.id, [
      { type: "run.started", run: first },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    await writeFile(join(root, "file.txt"), "after\n");
    // Record the thread done and let a maintenance pass that finds nothing due finish, then land
    // the run's end: its "after" waits for the next admission, as it does when that pool is full.
    store.appendEvents(thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
    await runtime.checkpoints.settled();
    store.appendEvents(thread.id, [
      { type: "run.ended", runId: first.id, state: "completed", endedAt: 2 },
    ]);

    await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("second"));
    const [ended] = await runs(1);
    if (!ended?.checkpoints?.before || !ended.checkpoints.after)
      throw new Error("Expected checkpoint refs");
    expect(ended.checkpoints.before).not.toBe(ended.checkpoints.after);

    const second = turn("turn-two", 3);
    store.appendEvents(thread.id, [
      { type: "run.started", run: second },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    const [followUp] = await runs(1);
    expect(followUp?.id).toBe(second.id);
    expect(followUp?.checkpoints).toMatchObject({
      before: ended.checkpoints.after,
      state: "pending",
    });
    const boundary = await runtime.git.diff({
      worktree: root,
      from: { kind: "checkpoint", id: ended.checkpoints.before },
      to: { kind: "checkpoint", id: ended.checkpoints.after },
    });
    expect(boundary.patch).toContain("-before");
    expect(boundary.patch).toContain("+after");

    await writeFile(join(root, "file.txt"), "third\n");
    store.appendEvents(thread.id, [
      { type: "run.ended", runId: second.id, state: "completed", endedAt: 4 },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    await runtime.checkpoints.settled();
    const [finished] = await runs(1);
    expect(finished?.checkpoints?.state).toBe("ready");
    if (!finished?.checkpoints?.before || !finished.checkpoints.after)
      throw new Error("Expected checkpoint refs");
    const turnDiff = await runtime.git.diff({
      worktree: root,
      from: { kind: "checkpoint", id: finished.checkpoints.before },
      to: { kind: "checkpoint", id: finished.checkpoints.after },
    });
    expect(turnDiff.patch).toContain("-after");
    expect(turnDiff.patch).toContain("+third");
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("a turn boundary held at admission takes one snapshot, even when a maintenance slot opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-run-held-"));
  await git("git", ["init", root]);
  await git("git", ["-C", root, "config", "user.name", "ace test"]);
  await git("git", ["-C", root, "config", "user.email", "test@ace.local"]);
  await writeFile(join(root, "file.txt"), "before\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", ["-C", root, "commit", "-m", "Initial"]);
  const data = await mkdtemp(join(tmpdir(), "ace-run-store-"));
  const store = new Store(join(data, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const newThread = (id: string, title: string) =>
    Thread.parse({
      id,
      workspaceId,
      provider: "codex",
      rootAgentId: "root",
      title,
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
  const thread = newThread("thread", "Follow up");
  // The maintenance pool holds 16 captures. These turns fill every slot while the turn under
  // test ends, so its own maintenance capture cannot start when the thread reports done.
  const busy = Array.from({ length: 16 }, (_, i) => newThread(`busy-${i}`, `Busy ${i}`));
  for (const created of [thread, ...busy])
    store.appendEvents(created.id, [{ type: "thread.created", thread: created }]);
  // A real snapshot finishes in milliseconds, so the pool cannot stay full on its own. Holding
  // the captures at the git edge keeps every slot busy and lets admission's capture be held too.
  const checkpoints = new GatedCheckpoints();
  const runtime = new WorkspaceRuntime(store, data, () => 1000, { gitService: checkpoints });
  const latestRun = async (threadId: ThreadId) => {
    const page = (
      await runtime.read({
        type: "workspace.request",
        requestId: "runs",
        operation: {
          op: "runs.list",
          threadId,
          before: Number.MAX_SAFE_INTEGER,
          limit: 1,
        },
      })
    ).result;
    if (page.kind !== "runs") throw new Error("Expected runs");
    return page.runs[0];
  };
  const busyRuns = busy.map((holder, i) => rootTurn(holder.id, `busy-${i}`));
  const first = rootTurn(thread.id, "turn-one");
  const second = rootTurn(thread.id, "turn-two");
  try {
    for (const [i, holder] of busy.entries()) {
      await runtime.checkpoints.beforeSend(holder.id, CommandId.parse(`boundary-${i}`));
      store.appendEvents(holder.id, [
        { type: "run.started", run: busyRuns[i]! },
        { type: "thread.updated", status: { state: "working", agents: 1 } },
      ]);
    }
    await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("first"));
    store.appendEvents(thread.id, [
      { type: "run.started", run: first },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    await writeFile(join(root, "file.txt"), "after\n");

    checkpoints.holding = true;
    for (const [i, holder] of busy.entries())
      store.appendEvents(holder.id, [
        { type: "run.ended", runId: busyRuns[i]!.id, state: "completed", endedAt: 2 },
        { type: "thread.updated", status: { state: "done" } },
      ]);
    await checkpoints.waitFor(16);
    // The normal order: the turn ends, then the thread reports done. With every slot held the
    // maintenance capture is refused, so the "after" is still due when the next message arrives.
    store.appendEvents(thread.id, [
      { type: "run.ended", runId: first.id, state: "completed", endedAt: 3 },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    // Admission takes the due row without waiting for the pool, and is held here too.
    const next = runtime.checkpoints.beforeSend(thread.id, CommandId.parse("second"));
    // Handled from the start: a failed wait must not leave this rejection unobserved.
    void next.catch(() => {});
    await checkpoints.waitFor(17);
    // Free two slots: the maintenance pass the second one allows must not capture the same row.
    checkpoints.releaseThread(busy[0]!.id);
    checkpoints.releaseThread(busy[1]!.id);
    await vi.waitFor(() =>
      expect(
        busy
          .slice(0, 2)
          .map(
            (holder, i) => store.snapshotThread(holder.id).runs[`busy-${i}`]?.checkpoints?.state,
          ),
      ).toEqual(["ready", "ready"]),
    );
    // Admission's own capture is the one that publishes the shared boundary.
    checkpoints.releaseThread(thread.id);
    await next;
    // The parked pool is not what this test asserts. Another capture of this same turn, if one
    // was let through, runs against Git so the refs show it; every other one fails.
    checkpoints.failCapturesOtherThan(thread.id);
    checkpoints.releaseAll();
    await runtime.checkpoints.settled();

    const ended = await latestRun(thread.id);
    expect(ended?.id).toBe("turn-one");
    expect(ended?.checkpoints?.state).toBe("ready");
    if (!ended?.checkpoints?.before || !ended.checkpoints.after)
      throw new Error("Expected checkpoint refs");
    const refs = await checkpoints.listCheckpoints({ repo: root, threadId: thread.id });
    // One "after" snapshot for the turn, and the same one the next turn starts from.
    expect(refs.filter((ref) => ref.label === "After turn 1").map((ref) => ref.id)).toEqual([
      ended.checkpoints.after,
    ]);
    const boundary = await runtime.git.diff({
      worktree: root,
      from: { kind: "checkpoint", id: ended.checkpoints.before },
      to: { kind: "checkpoint", id: ended.checkpoints.after },
    });
    expect(boundary.patch).toContain("-before");
    expect(boundary.patch).toContain("+after");

    store.appendEvents(thread.id, [{ type: "run.started", run: second }]);
    const followUp = await latestRun(thread.id);
    expect(followUp?.id).toBe("turn-two");
    expect(followUp?.checkpoints).toMatchObject({
      before: ended.checkpoints.after,
      state: "pending",
    });
  } finally {
    checkpoints.failCapturesOtherThan(thread.id);
    // Ungate before releasing so nothing released can park itself again and wedge this cleanup.
    checkpoints.reopen();
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("failed admissions leave the maintenance slots for a finished thread's after checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-run-admission-"));
  await git("git", ["init", root]);
  await git("git", ["-C", root, "config", "user.name", "ace test"]);
  await git("git", ["-C", root, "config", "user.email", "test@ace.local"]);
  await writeFile(join(root, "file.txt"), "before\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", ["-C", root, "commit", "-m", "Initial"]);
  const data = await mkdtemp(join(tmpdir(), "ace-run-store-"));
  const store = new Store(join(data, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const newThread = (id: string, title: string) =>
    Thread.parse({
      id,
      workspaceId,
      provider: "codex",
      rootAgentId: "root",
      title,
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
  const thread = newThread("thread", "Ends while 16 sends are held");
  // Sixteen messages are admitted at once. Each parks its capture, so the senders alone would
  // fill a pool that counted admissions against it.
  const senders = Array.from({ length: 16 }, (_, i) => newThread(`sender-${i}`, `Sender ${i}`));
  for (const created of [thread, ...senders])
    store.appendEvents(created.id, [{ type: "thread.created", thread: created }]);
  // Only the finishing thread reaches Git; the held senders fail their admission when they resume.
  const checkpoints = new GatedCheckpoints();
  checkpoints.quarantineCapturesOtherThan(thread.id);
  const runtime = new WorkspaceRuntime(store, data, () => 1000, { gitService: checkpoints });
  const turn = rootTurn(thread.id, "turn-one");
  const due = () =>
    store.atomic((db) =>
      db.prepare("SELECT run_id FROM client_checkpoint_due WHERE thread_id=?").all(thread.id),
    );
  const admissions: Array<Promise<void>> = [];
  try {
    await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("first"));
    store.appendEvents(thread.id, [
      { type: "run.started", run: turn },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    await writeFile(join(root, "file.txt"), "after\n");

    checkpoints.holding = true;
    for (const [i, sender] of senders.entries())
      admissions.push(runtime.checkpoints.beforeSend(sender.id, CommandId.parse(`send-${i}`)));
    const rejected = Promise.allSettled(admissions);
    await checkpoints.waitFor(16);
    // The turn ends with every send still parked. No further event follows: the thread's own
    // maintenance flight has room for the "after" it just queued.
    store.appendEvents(thread.id, [
      { type: "run.ended", runId: turn.id, state: "completed", endedAt: 2 },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    await vi.waitFor(() => expect(due()).toEqual([]), { timeout: GATE_DEADLINE_MS });
    const captured = store.snapshotThread(thread.id).runs[turn.id]?.checkpoints;
    expect(captured?.state).toBe("ready");
    if (!captured?.after) throw new Error("Expected an after checkpoint");
    const refs = await checkpoints.listCheckpoints({ repo: root, threadId: thread.id });
    expect(refs.filter((ref) => ref.label.startsWith("After turn ")).map((ref) => ref.id)).toEqual([
      captured.after,
    ]);

    // The held sends now fail. Their threads never admitted, and the finished one keeps its
    // captured "after": a failed admission leaves the same clean state a successful one does.
    checkpoints.reopen();
    const outcomes = await rejected;
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(16);
    expect(store.snapshotThread(thread.id).runs[turn.id]?.checkpoints).toEqual(captured);
    expect(due()).toEqual([]);
  } finally {
    checkpoints.reopen();
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
