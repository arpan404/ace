import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import {
  MonitorSnapshot,
  ThreadId,
  WaitResult,
  type AgentControlResult,
  type WaitMode,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import { daemonFixture } from "./daemon-test-support.ts";
import { end, start } from "../engine/test-support.ts";

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;

/** Scripted Claude children start a turn and keep working until the test settles them. */
async function spawn(f: Fixture, name: string, role = "worker") {
  const result = await f.call({
    op: "delegate_task",
    requestId: name,
    provider: "claude",
    task: `Do ${name}`,
    role,
    wait: false,
    estimatedLoad: 0,
  });
  await f.daemon.engine?.flush();
  return z.object({ threadId: ThreadId }).parse(result.data).threadId;
}
/** Delivers scripted provider frames to the daemon's own engine and waits for them. */
async function emit(f: Fixture, thread: ThreadId, ...facts: Fact[]) {
  const context = f.h.contexts.get(thread);
  if (!context) throw new Error("Missing native session");
  context.onFrame(f.h.frames.frame(...facts));
  await f.daemon.engine?.flush();
}
const complete = (f: Fixture, thread: ThreadId, text: string) =>
  emit(f, thread, output(`result-${thread}`, text), end);
function wait(f: Fixture, ids: ThreadId[], mode: WaitMode, timeoutSeconds = 60) {
  return f.call({ op: "wait", threadIds: ids, mode, timeoutSeconds });
}
function waited(result: AgentControlResult) {
  expect(result.ok).toBe(true);
  return WaitResult.parse(result.data);
}
/** True when the promise has not settled after the daemon has handled every queued change. */
async function stillPending(f: Fixture, promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => (settled = true));
  await f.daemon.engine?.flush();
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  return !settled;
}
const ask = (text: string): Fact => ({
  type: "interaction.opened",
  agent: "root",
  interaction: "ask",
  blocking: true,
  request: {
    kind: "question",
    questions: [
      {
        id: "choice",
        text,
        options: [{ id: "pg", label: "Postgres" }],
        multiSelect: false,
        allowOther: false,
      },
    ],
  },
});
const output = (item: string, text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role: "assistant", parts: [{ type: "text", text }], complete: true },
});

test("waiting for all children returns only after both finish, with each result", async () => {
  const f = await daemonFixture();
  try {
    const [alpha, beta] = [await spawn(f, "alpha"), await spawn(f, "beta")];
    const pending = wait(f, [alpha, beta], "all");
    await complete(f, alpha, "alpha is done");
    expect(await stillPending(f, pending)).toBe(true);
    await complete(f, beta, "beta is done");
    const result = waited(await pending);
    expect(result.status).toBe("ready");
    expect(result.threads).toMatchObject([
      { threadId: alpha, state: "done", result: "alpha is done" },
      { threadId: beta, state: "done", result: "beta is done" },
    ]);
  } finally {
    await f.daemon.close();
  }
});

test("waiting for any thread returns on the first to finish while the other keeps working", async () => {
  const f = await daemonFixture();
  try {
    const [alpha, beta] = [await spawn(f, "alpha"), await spawn(f, "beta")];
    const pending = f.call({
      op: "wait",
      threadIds: [alpha, beta],
      mode: "any",
      timeoutSeconds: 60,
    });
    expect(await stillPending(f, pending)).toBe(true);
    await complete(f, beta, "beta first");
    const result = waited(await pending);
    expect(result.status).toBe("ready");
    expect(result.threads).toMatchObject([
      { threadId: alpha, state: "working" },
      { threadId: beta, state: "done", result: "beta first" },
    ]);
    expect(f.daemon.store.getThread(alpha)?.status.state).toBe("working");
  } finally {
    await f.daemon.close();
  }
});

test("a timeout returns current progress without failing and the child keeps working", async () => {
  const f = await daemonFixture();
  try {
    const child = await spawn(f, "slow");
    await emit(f, child, output("progress", "Reading files\nstep 1 of 3: parsing the schema"));
    const pending = wait(f, [child], "all", 30);
    await f.h.clock.waitForDelay(30_000);
    f.h.clock.advance(f.h.clock.now() + 30_000);
    const result = waited(await pending);
    expect(result).toMatchObject({
      status: "timeout",
      threads: [{ threadId: child, state: "working", last: "step 1 of 3: parsing the schema" }],
    });
    expect(f.daemon.store.getThread(child)?.status.state).toBe("working");
    // The agent can wait again and receive the result.
    const again = wait(f, [child], "all");
    await complete(f, child, "schema parsed");
    expect(waited(await again)).toMatchObject({
      status: "ready",
      threads: [{ state: "done", result: "schema parsed" }],
    });
  } finally {
    await f.daemon.close();
  }
});

test("a child asking the person returns needs_you with the request, in both modes", async () => {
  const f = await daemonFixture();
  try {
    const [asker, worker] = [await spawn(f, "asker"), await spawn(f, "worker")];
    const pending = wait(f, [asker, worker], "all");
    await emit(f, asker, ask("Which database should I use?"));
    const result = waited(await pending);
    expect(result.status).toBe("needs_you");
    expect(result.threads).toMatchObject([
      {
        threadId: asker,
        state: "needs_you",
        needs: [{ kind: "question", prompt: "Which database should I use?" }],
      },
      { threadId: worker, state: "working" },
    ]);
    // Waiting again does not block while the request is still open.
    expect(waited(await wait(f, [asker], "any")).status).toBe("needs_you");
  } finally {
    await f.daemon.close();
  }
});

test("a daemon shutdown mid-wait returns interrupted instead of hanging", async () => {
  const f = await daemonFixture();
  const child = await spawn(f, "survivor");
  const pending = wait(f, [child], "all", 600);
  expect(await stillPending(f, pending)).toBe(true);
  await f.daemon.close();
  expect(waited(await pending)).toMatchObject({
    status: "interrupted",
    threads: [{ threadId: child }],
  });
});

test("a wait refuses threads in another project", async () => {
  const f = await daemonFixture();
  try {
    const elsewhere = await mkdtemp(join(tmpdir(), "ace-elsewhere-"));
    onTestFinished(() => rm(elsewhere, { recursive: true, force: true }));
    const created = f.controls.delegations.command("unrelated", {
      type: "thread.create",
      workspaceId: f.daemon.store.createWorkspace(elsewhere, "elsewhere"),
      provider: "codex",
      input: [{ type: "text", text: "unrelated" }],
    });
    const unrelated = ThreadId.parse(created.threadId);
    expect(await wait(f, [unrelated], "all")).toMatchObject({ ok: false, code: "forbidden" });
  } finally {
    await f.daemon.close();
  }
});

test("the parent reads waiting on its subagents during a wait, never done", async () => {
  const f = await daemonFixture();
  try {
    const child = await spawn(f, "awaited");
    const parent = f.caller.threadId;
    const call = (status: "running" | "succeeded"): Fact => ({
      type: "item.upsert",
      agent: "root",
      item: "wait-call",
      draft: {
        type: "tool_call",
        complete: status === "succeeded",
        call: {
          title: "Wait",
          kind: "mcp",
          status,
          detail: {
            kind: "mcp",
            server: "ace",
            tool: "mcp__ace__ace_wait",
            arguments: { threadIds: [child], mode: "all", timeoutSeconds: 60 },
          },
        },
      },
    });
    await emit(f, parent, start, call("running"));
    const root = () => f.daemon.store.getMcpAgent(parent, f.caller.agentId)?.status;
    expect(root()).toMatchObject({ state: "blocked", on: "subagents" });
    expect(root()).toHaveProperty("refs.length", 1);
    expect(f.daemon.store.getThread(parent)).toMatchObject({
      status: { state: "working" },
      live: { waitingOn: 1 },
    });
    await complete(f, child, "finished");
    expect(f.daemon.store.getThread(parent)?.status.state).toBe("working");
    await emit(f, parent, call("succeeded"), end);
    expect(f.daemon.store.getThread(parent)?.live?.waitingOn).toBeUndefined();
  } finally {
    await f.daemon.close();
  }
});

test("the tree snapshot stays small with twenty children", async () => {
  const f = await daemonFixture({ policy: { maxConcurrent: 24 } });
  try {
    const children: ThreadId[] = [];
    for (let index = 0; index < 20; index++)
      children.push(
        await spawn(f, `child-${index}`, `${"very detailed role ".repeat(12)}${index}`),
      );
    for (const child of children.slice(0, 10))
      await emit(f, child, output("long", `${"verbose progress line ".repeat(40)}\n`.repeat(20)));
    await emit(f, children[19]!, ask(`${"Should I really proceed with this change? ".repeat(10)}`));
    await complete(f, children[18]!, "done early");
    const result = await f.call({ op: "agents.status" });
    expect(result.ok).toBe(true);
    const snapshot = MonitorSnapshot.parse(result.data);
    expect(snapshot.children).toHaveLength(20);
    expect(snapshot.counts).toMatchObject({ working: 18, needs_you: 1, done: 1 });
    expect(snapshot.children.find((child) => child.id === children[19])).toMatchObject({
      state: "needs_you",
      needs: 1,
      ask: expect.stringContaining("Should I really proceed"),
    });
    expect(snapshot.children.find((child) => child.id === children[0])?.last).toContain(
      "verbose progress line",
    );
    expect(JSON.stringify(result.data).length).toBeLessThan(8192);
  } finally {
    await f.daemon.close();
  }
});
