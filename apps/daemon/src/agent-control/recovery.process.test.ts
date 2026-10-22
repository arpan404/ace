import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AgentControlOperation, ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup, wakes } from "./test-support.ts";
import { start } from "../engine/test-support.ts";

test("durable pending results survive service restart and are consumed exactly once", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "recover-result");
  await h.engine.flush();
  await h.complete(edge.childId, "retained");
  h.restartOwner();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
  h.restartOwner();
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
});

test("daemon crash holds a live delegation until explicit native recovery without replaying its input", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "crash");
  await h.engine.flush();
  const nativeSessionId = [...h.nativeHistories.keys()].find((id) =>
    id.startsWith("native-claude-"),
  );
  if (!nativeSessionId) throw new Error("Missing child native history");
  const snapshot = join(h.home, "crash.sqlite");
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
  expect(recovered.engine.queue(edge.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(recovered.store.getThread(edge.childId)?.status).toEqual({
    state: "waiting",
    on: "queue",
  });
  expect(recovered.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  expect(recovered.engine.queue(parent.threadId).paused).toBe(false);
  expect(recovered.contexts.has(edge.childId)).toBe(false);
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(0);
  expect(
    recovered.service.command("recover-child", {
      type: "thread.resume",
      threadId: edge.childId,
      expectedRevision: recovered.engine.queue(edge.childId).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(recovered.contexts.get(edge.childId)?.resume).toEqual({
    nativeSessionId,
  });
  expect(recovered.inputs.get(edge.childId)).toEqual(["Continue where you left off."]);
  await recovered.complete(edge.childId, "recovered completion");
  recovered.clock.advance(1100);
  await recovered.engine.flush();
  const outcome = await recovered.service.wait(parent, edge.childId, new AbortController().signal);
  expect(outcome.outcome).toBe("completed");
  expect(wakes(recovered.events, parent.threadId)).toHaveLength(1);
});

/** Crashes `h` mid-work and reopens its database as a fresh daemon. */
async function crash(h: ReturnType<typeof setup>, name: string) {
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

test("resuming a parent after a daemon crash resumes the delegated children the crash stopped", async () => {
  const h = setup();
  const parent = await h.parent();
  // The parent is mid-turn, waiting on its child, when the daemon dies.
  await h.emit(parent.threadId, start);
  const edge = h.delegate(parent, "held-child");
  await h.engine.flush();
  const recovered = await crash(h, "held-child");
  expect(recovered.engine.queue(parent.threadId)).toMatchObject({
    paused: true,
    reason: "restart",
  });
  expect(recovered.engine.queue(edge.childId)).toMatchObject({ paused: true, reason: "restart" });
  expect(
    recovered.service.command("resume-parent", {
      type: "thread.resume",
      threadId: parent.threadId,
      expectedRevision: recovered.engine.queue(parent.threadId).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(edge.childId)).toEqual(["Continue where you left off."]);
  expect(recovered.engine.queue(edge.childId).paused).toBe(false);
  await recovered.complete(edge.childId, "finished after restart");
  const outcome = await recovered.service.wait(parent, edge.childId, new AbortController().signal);
  expect(outcome.outcome).toBe("completed");
});

test("resuming a parent after a daemon crash leaves a child the person stopped held", async () => {
  const h = setup();
  const parent = await h.parent();
  await h.emit(parent.threadId, start);
  const kept = h.delegate(parent, "kept-child");
  const stopped = h.delegate(parent, "stopped-child");
  await h.engine.flush();
  const recovered = await crash(h, "stopped-child");
  recovered.service.journal.stopMember(stopped.childId);
  expect(
    recovered.service.command("resume-parent", {
      type: "thread.resume",
      threadId: parent.threadId,
      expectedRevision: recovered.engine.queue(parent.threadId).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(kept.childId)).toEqual(["Continue where you left off."]);
  expect(recovered.inputs.get(stopped.childId)).toBeUndefined();
  expect(recovered.engine.queue(stopped.childId)).toMatchObject({
    paused: true,
    reason: "restart",
  });
});

test("a parent's wait on a child still held after a restart returns at once and says why", async () => {
  const h = setup();
  const parent = await h.parent();
  await h.emit(parent.threadId, start);
  const edge = h.delegate(parent, "waited-child");
  await h.engine.flush();
  const recovered = await crash(h, "waited-child");
  const waiting = recovered.service.monitor.wait(
    parent,
    { threadIds: [edge.childId], mode: "all", timeoutSeconds: 1 },
    new AbortController().signal,
  );
  recovered.clock.advance(recovered.clock.now() + 2000);
  const result = await waiting;
  expect(result).toMatchObject({
    ok: true,
    data: { status: "needs_you", threads: [{ threadId: edge.childId, state: "needs_you" }] },
  });
  expect(JSON.stringify(result)).toContain("daemon restart");
});

test("resuming a parent after a daemon crash resumes the threads its agent started", async () => {
  const h = setup();
  const parent = await h.parent();
  await h.emit(parent.threadId, start);
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  let started: string | undefined;
  try {
    const context = {
      store: h.store,
      services: { workspaceActions: runtime },
      signal: new AbortController().signal,
    };
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(context, h.service, h.service.conversations),
    });
    const opened = await port.execute(
      parent,
      AgentControlOperation.parse({
        op: "thread.start",
        requestId: "started-thread",
        title: "Conversation",
        text: "Build this",
        provider: "claude",
        model: "chosen-model",
        effort: "high",
        workspace: { kind: "project" },
      }),
      new AbortController().signal,
    );
    expect(opened.ok).toBe(true);
    await h.engine.flush();
    started = h.store.listThreads().find((row) => row.id !== parent.threadId)?.id;
  } finally {
    await runtime.close();
  }
  if (!started) throw new Error("Started thread missing");
  const recovered = await crash(h, "started-thread");
  const thread = recovered.store.getThread(ThreadId.parse(started))?.id;
  if (!thread) throw new Error("Started thread lost");
  expect(recovered.engine.queue(thread)).toMatchObject({ paused: true, reason: "restart" });
  expect(
    recovered.service.command("resume-owner", {
      type: "thread.resume",
      threadId: parent.threadId,
      expectedRevision: recovered.engine.queue(parent.threadId).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(recovered.inputs.get(thread)).toEqual(["Continue where you left off."]);
});
