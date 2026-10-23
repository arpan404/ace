import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AgentControlOperation, Command, ThreadId, type McpAttribution } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { organizeThread } from "../thread-organization.ts";
import { question, start } from "../engine/test-support.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup } from "./test-support.ts";

/*
 * After a daemon restart, the person carrying a parent on carries on the work the restart
 * interrupted under it, and only that: finished, stopped and settled work stays as it was.
 * Work a restart cuts short mid-turn continues by itself (ADR 0098); these threads wait on the
 * person when ace stops, so the restart holds them for the person.
 */

type Harness = ReturnType<typeof setup>;
const signal = () => new AbortController().signal;
/** The one restart continuation a held thread receives when it is carried on. */
const continued = (inputs: string[] | undefined) =>
  (inputs ?? []).map((text) => text.startsWith("ace restarted while you were working"));

/** Crashes `h` mid-work and reopens its database as a fresh daemon. */
async function crash(h: Harness, name: string) {
  const snapshot = join(h.home, `${name}.sqlite`);
  let sourceDb: DatabaseSync | undefined;
  h.store.atomic((db) => {
    sourceDb = db;
  });
  if (!sourceDb) throw new Error("Missing snapshot source");
  await backup(sourceDb, snapshot);
  await h.close();
  const recovered = setup({}, snapshot);
  recovered.clock.advance(1050);
  await recovered.engine.flush();
  return recovered;
}

/** A parent mid-turn that asks the person something, so a restart holds it for them. */
async function busyParent(h: Harness) {
  const parent = await h.parent();
  await h.emit(parent.threadId, start, question);
  return parent;
}

/** The thread's agent asks the person something, so a restart holds it rather than continuing. */
async function asksPerson(h: Harness, thread: ThreadId) {
  await h.emit(thread, question);
}

/** The person's Resume of a held thread. */
function resume(h: Harness, thread: ThreadId) {
  return h.service.command(`resume-${thread}`, {
    type: "thread.resume",
    threadId: thread,
    expectedRevision: h.engine.queue(thread).revision,
  });
}

/** The person's Stop of a thread and everything under it. */
function stop(h: Harness, thread: ThreadId) {
  return h.service.command(`stop-${thread}`, {
    type: "thread.interrupt",
    threadId: thread,
    cascade: true,
  });
}

/** A thread the parent's agent opens with `thread_start`. */
async function startThread(h: Harness, parent: McpAttribution, requestId: string) {
  const runtime = new WorkspaceRuntime(h.store, join(h.home, requestId), h.clock.now);
  try {
    const context = { store: h.store, services: { workspaceActions: runtime }, signal: signal() };
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(context, h.service, h.service.conversations),
    });
    const opened = await port.execute(
      parent,
      AgentControlOperation.parse({
        op: "thread.start",
        requestId,
        title: "Conversation",
        text: "Build this",
        provider: "claude",
        model: "chosen-model",
        effort: "high",
        workspace: { kind: "project" },
      }),
      signal(),
    );
    if (!opened.ok) throw new Error("Thread start failed");
    await h.engine.flush();
  } finally {
    await runtime.close();
  }
  const thread = h.store.listThreads().find((row) => row.id !== parent.threadId)?.id;
  if (!thread) throw new Error("Started thread missing");
  return ThreadId.parse(thread);
}

test("resuming a parent after a daemon crash resumes the delegated children the crash stopped", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const edge = h.delegate(parent, "held-child");
  await h.engine.flush();
  await asksPerson(h, edge.childId);
  const recovered = await crash(h, "held-child");
  expect(recovered.engine.queue(parent.threadId)).toMatchObject({
    paused: true,
    reason: "restart",
  });
  expect(recovered.engine.queue(edge.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(continued(recovered.inputs.get(edge.childId))).toEqual([true]);
  expect(recovered.engine.queue(edge.childId).paused).toBe(false);
  await recovered.complete(edge.childId, "finished after restart");
  const outcome = await recovered.service.wait(parent, edge.childId, signal());
  expect(outcome.outcome).toBe("completed");
});

test("resuming a parent after a daemon crash resumes the threads its agent started", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const thread = await startThread(h, parent, "started-thread");
  await asksPerson(h, thread);
  const recovered = await crash(h, "started-thread");
  expect(recovered.engine.queue(thread)).toMatchObject({ paused: true, reason: "restart" });
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(continued(recovered.inputs.get(thread))).toEqual([true]);
});

test("resuming a parent after a daemon crash never restarts a child that had finished", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "finished-child");
  await h.engine.flush();
  await h.complete(edge.childId, "done before the crash");
  await h.emit(parent.threadId, start);
  const recovered = await crash(h, "finished-child");
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(edge.childId)).toBeUndefined();
  expect(recovered.store.getThread(edge.childId)?.status.state).toBe("done");
});

test("resuming a parent after a daemon crash never restarts a child the person stopped before it", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const edge = h.delegate(parent, "stopped-before");
  await h.engine.flush();
  expect(stop(h, edge.childId).ok).toBe(true);
  await h.engine.flush();
  const recovered = await crash(h, "stopped-before");
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(edge.childId)).toBeUndefined();
  expect(recovered.store.getThread(edge.childId)?.status.state).not.toBe("working");
});

test("resuming a parent after a daemon crash never restarts a held child the person then stopped", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const kept = h.delegate(parent, "kept-child");
  const stopped = h.delegate(parent, "stopped-after");
  await h.engine.flush();
  await asksPerson(h, kept.childId);
  await asksPerson(h, stopped.childId);
  const recovered = await crash(h, "stopped-after");
  expect(stop(recovered, stopped.childId).ok).toBe(true);
  await recovered.engine.flush();
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(continued(recovered.inputs.get(kept.childId))).toEqual([true]);
  expect(recovered.inputs.get(stopped.childId)).toBeUndefined();
  expect(recovered.store.getThread(stopped.childId)?.status.state).not.toBe("working");
});

test("resuming a parent after a daemon crash never restarts a started thread the person settled", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const thread = await startThread(h, parent, "settled-thread");
  await asksPerson(h, thread);
  const recovered = await crash(h, "settled-thread");
  const settled = organizeThread(
    recovered.store,
    Command.parse({
      id: "settle-started",
      deviceId: "device",
      payload: { type: "thread.settle", threadId: thread },
    }),
    recovered.clock.now(),
  );
  expect(settled.ok).toBe(true);
  await recovered.engine.flush();
  expect(resume(recovered, parent.threadId).ok).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(thread)).toBeUndefined();
});

test("a parent's wait on a child still held after a restart returns at once and says why", async () => {
  const h = setup();
  const parent = await busyParent(h);
  const edge = h.delegate(parent, "waited-child");
  await h.engine.flush();
  await asksPerson(h, edge.childId);
  const recovered = await crash(h, "waited-child");
  const waiting = recovered.service.monitor.wait(
    parent,
    { threadIds: [edge.childId], mode: "all", timeoutSeconds: 1 },
    signal(),
  );
  recovered.clock.advance(recovered.clock.now() + 2000);
  const result = await waiting;
  expect(result).toMatchObject({
    ok: true,
    data: { status: "needs_you", threads: [{ threadId: edge.childId, state: "needs_you" }] },
  });
  expect(JSON.stringify(result)).toContain("daemon restart");
});

test("a parent's wait on a child that finished before a restart still reads its result", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "finished-wait");
  await h.engine.flush();
  await h.complete(edge.childId, "the answer");
  await h.emit(parent.threadId, start);
  const recovered = await crash(h, "finished-wait");
  const result = await recovered.service.monitor.wait(
    parent,
    { threadIds: [edge.childId], mode: "all", timeoutSeconds: 1 },
    signal(),
  );
  expect(result).toMatchObject({
    ok: true,
    data: { status: "ready", threads: [{ threadId: edge.childId, state: "done" }] },
  });
});
