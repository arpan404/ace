import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Thread, Run, CommandId, AgentId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const git = promisify(execFile);
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
