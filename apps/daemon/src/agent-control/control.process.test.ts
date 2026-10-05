import { z } from "zod";
import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { ToolRegistry, agentControlToolkit } from "@ace/mcp-server";
import { createAgentControlPort } from "@ace/daemon";
import { question, end } from "../engine/test-support.ts";
import { setup, wakes } from "./test-support.ts";

test("cross-provider child preserves its selection and returns the whole thread result to its waiting parent", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "implementation", true);
  await h.engine.flush();
  const waiting = h.service.wait(parent, edge.childId, new AbortController().signal);
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("working");
  expect(h.contexts.get(edge.childId)).toMatchObject({
    model: "chosen-model",
    options: { effort: "high" },
  });
  expect(h.store.getThread(edge.childId)?.provider).toBe("claude");
  expect(Object.values(h.store.snapshotThread(edge.childId).items)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        synthetic: true,
        origin: expect.objectContaining({
          kind: "spawn",
          parentThreadId: parent.threadId,
          role: "implementer",
        }),
      }),
    ]),
  );

  await h.complete(edge.childId, "implemented");
  expect(await waiting).toMatchObject({ outcome: "completed", result: "implemented" });
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  const view = h.store.snapshotThread(parent.threadId);
  expect(Object.values(view.items)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "delegation.settled",
        delivery: "tool",
        origin: "ace",
        results: [expect.objectContaining({ threadId: edge.childId, result: "implemented" })],
      }),
    ]),
  );

  expect(Object.values(view.agents).some((agent) => agent.childThreadId === edge.childId)).toBe(
    true,
  );
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
  expect(h.errors).toEqual([]);
});

test("near-simultaneous completions wake once with every outcome while another child keeps working", async () => {
  const h = setup();
  const parent = await h.parent();
  const a = h.delegate(parent, "a"),
    b = h.delegate(parent, "b"),
    c = h.delegate(parent, "c");
  await h.engine.flush();
  await h.complete(a.childId, "A");
  await h.complete(b.childId, "B");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
  const text = h.inputs.get(parent.threadId)?.join("\n") ?? "";
  expect(text).toContain(a.childId);
  expect(text).toContain(b.childId);
  expect(text).toContain('"result":"A"');
  expect(text).toContain('"result":"B"');
  expect(h.store.getThread(c.childId)?.status.state).toBe("working");
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("working");
});

test("parent waits for a child's background task after its foreground turn ends", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "background");
  await h.engine.flush();
  await h.emit(
    edge.childId,
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "build",
      stoppable: true,
      ambient: false,
    },
    end,
  );
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.status).toMatchObject({
    state: "waiting",
    on: "background_task",
  });
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  await h.emit(edge.childId, { type: "background.ended", task: "build", status: "completed" });
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
});

test("interrupt cancels descendants, prevents prepared children launching, and suppresses wakes", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "child");
  await h.engine.flush();
  const grandchild = h.delegate(h.caller(child.childId), "grandchild");
  await h.engine.flush();
  const prepared = h.service.prepare(parent, {
    requestId: "prepared",
    task: "later",
    role: "later",
    provider: "claude",
    wait: false,
    estimatedLoad: 0,
  });
  h.service.cancelDescendants(parent.threadId);
  await h.engine.flush();
  for (const thread of [child.childId, grandchild.childId, prepared.childId])
    expect(await h.service.wait(parent, thread, new AbortController().signal)).toMatchObject({
      outcome: "cancelled",
    });
  expect(h.contexts.has(prepared.childId)).toBe(false);
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
});

test("depth and per-parent concurrency reject extra work without creating threads", async () => {
  const h = setup({ maxConcurrent: 1, maxDepth: 1 });
  const parent = await h.parent();
  const child = h.delegate(parent, "one");
  await h.engine.flush();
  expect(() => h.delegate(parent, "two")).toThrow("concurrency");
  expect(() => h.delegate(h.caller(child.childId), "deep")).toThrow("depth");
  expect(h.store.listThreads()).toHaveLength(2);
  await h.complete(child.childId, "done");
  h.delegate(parent, "after-completion");
  expect(h.store.listThreads()).toHaveLength(3);
});

test("request retries reuse the independent thread and conflicting payloads are rejected", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "retry");
  expect(h.delegate(parent, "retry").childId).toBe(edge.childId);
  expect(() => h.delegate(parent, "retry", true)).toThrow("identity conflict");
  await h.engine.flush();
  expect(h.store.listThreads()).toHaveLength(2);
});

test("agent cannot approve its own permission request through a question tool or forged operation", async () => {
  const h = setup();
  const parent = await h.parent();
  await h.emit(parent.threadId, question);
  const interaction = Object.values(h.store.snapshotThread(parent.threadId).interactions).find(
    (entry) => entry.state === "pending",
  );
  if (!interaction) throw new Error("Approval missing");
  const port = createAgentControlPort(h.store, h.service);
  expect(
    await port.execute(
      parent,
      {
        op: "question.answer",
        threadId: parent.threadId,
        requestId: "fake-question",
        interactionId: interaction.id,
        answer: { kind: "question", answers: {} },
      },
      new AbortController().signal,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit(port).register(registry);
  const result = await registry.call(
    "ace_question_answer",
    {
      threadId: parent.threadId,
      requestId: "approval",
      interactionId: interaction.id,
      answer: { kind: "approval", optionId: "yes" },
    },
    {
      scope: { ...parent, capabilities: ["thread_control"] },
      signal: new AbortController().signal,
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(h.store.getInteraction(interaction.id)?.state).toBe("pending");
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("needs_you");
});

test("children can read context but cannot mutate ancestors or unrelated threads", async () => {
  const h = setup();
  const parent = await h.parent(),
    other = await h.parent();
  const child = h.delegate(parent, "reader");
  await h.engine.flush();
  const port = createAgentControlPort(h.store, h.service);
  const caller = h.caller(child.childId);
  expect(
    (
      await port.execute(
        caller,
        { op: "thread.read", threadId: parent.threadId, limit: 1 },
        new AbortController().signal,
      )
    ).ok,
  ).toBe(true);
  for (const target of [parent.threadId, other.threadId])
    expect(
      await port.execute(
        caller,
        { op: "thread.interrupt", threadId: target, requestId: "denied" },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
});

test("agents answer real questions through the existing resolution API", async () => {
  const h = setup({}, undefined, true);
  const parent = await h.parent();
  const interaction = Object.values(h.store.snapshotThread(parent.threadId).interactions).find(
    (entry) => entry.state === "pending",
  );
  if (!interaction) throw new Error("Question missing");
  const result = await createAgentControlPort(h.store, h.service).execute(
    parent,
    {
      op: "question.answer",
      threadId: parent.threadId,
      interactionId: interaction.id,
      requestId: "answer",
      answer: { kind: "question", answers: { choice: ["safe"] } },
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getInteraction(interaction.id)).toMatchObject({
    state: "resolved",
    resolution: { kind: "question", answers: { choice: ["safe"] } },
  });
  await h.emit(parent.threadId, end);
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
});

test("cumulative usage is counted once and the tree is cancelled when its token budget is spent", async () => {
  const h = setup({ tokens: 100 });
  const parent = await h.parent();
  const edge = h.delegate(parent, "budget");
  await h.engine.flush();
  const usage: Fact = {
    type: "usage",
    agent: "root",
    inputTokens: 30,
    outputTokens: 20,
    counterMode: "cumulative",
    counterKey: "run",
  };
  await h.emit(edge.childId, usage, usage);
  expect(h.store.getThread(edge.childId)?.status.state).toBe("working");
  await h.emit(edge.childId, { ...usage, inputTokens: 80 });
  expect(await h.service.wait(parent, edge.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  expect(() => h.delegate(parent, "over-budget")).toThrow("cancelled");
});

test("elapsed budget cancels live work even when the provider sends no more frames", async () => {
  const h = setup({ durationMs: 100 });
  const parent = await h.parent();
  const edge = h.delegate(parent, "silent");
  await h.engine.flush();
  h.clock.advance(1100);
  await h.engine.flush();
  expect(await h.service.wait(parent, edge.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
});

test("a silent child stays relevant and a child's permission request makes the parent need a human", async () => {
  const h = setup();
  const parent = await h.parent();
  const edge = h.delegate(parent, "human");
  await h.engine.flush();
  await h.emit(edge.childId, { type: "agent.disconnected", agent: "root" });
  expect(h.store.getThread(edge.childId)?.status.state).toBe("unresponsive");
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("unresponsive");
  await h.emit(edge.childId, { type: "agent.reconnected", agent: "root" }, question);
  expect(h.store.getThread(parent.threadId)?.status).toMatchObject({
    state: "needs_you",
    interactions: 1,
  });
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
});

test("cancellation during provider opening aborts before sending and waits for opening cleanup", async () => {
  const entered = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const h = setup({}, undefined, false, { entered: () => entered.resolve(), ready: ready.promise });
  const parent = await h.parent();
  const child = h.delegate(parent, "opening");
  await entered.promise;
  const context = h.contexts.get(child.childId);
  if (!context) throw new Error("Missing opening context");
  const aborted = Promise.withResolvers<void>();
  context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
  h.service.cancelDescendants(parent.threadId);
  await aborted.promise;
  expect(h.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  ready.resolve();
  await h.engine.flush();
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  expect(Object.values(h.store.snapshotThread(child.childId).runs)).toHaveLength(0);
});

test("follow-up messages wake again on the same native thread and retries do not reopen completed work", async () => {
  const h = setup({}, undefined, false, undefined, true);
  const parent = await h.parent();
  const child = h.delegate(parent, "iterative");
  await h.engine.flush();
  await h.complete(child.childId, "first");
  h.clock.advance(1050);
  await h.engine.flush();
  const initialNativeId = [...h.nativeHistories.keys()].find((id) =>
    id.startsWith("native-claude-"),
  );
  if (!initialNativeId) throw new Error("Missing native child history");
  // Force the idle process to close. The follow-up must resume provider history.
  h.clock.advance(101100);
  await h.engine.flush();
  const port = createAgentControlPort(h.store, h.service);
  const message = {
    op: "thread.message",
    threadId: child.childId,
    requestId: "followup",
    text: "Refine the result",
    delivery: "queue",
  } satisfies import("@ace/protocol").AgentControlOperation;
  expect((await port.execute(parent, message, new AbortController().signal)).ok).toBe(true);
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("working");
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("working");
  expect(h.contexts.get(child.childId)?.resume?.nativeSessionId).toBe(initialNativeId);
  expect(h.nativeHistories.get(initialNativeId)).toEqual([
    "Role: implementer\n\nTask:\nImplement safely",
    "Refine the result",
  ]);
  await h.complete(child.childId, "refined");
  h.clock.advance(101150);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(2);
  expect((await port.execute(parent, message, new AbortController().signal)).ok).toBe(true);
  await h.engine.flush();
  h.clock.advance(101200);
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
  expect(wakes(h.events, parent.threadId)).toHaveLength(2);
  expect(h.store.listThreads()).toHaveLength(2);
});

test("agents page large child output and cannot substitute another thread's stream", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "large");
  await h.engine.flush();
  await h.complete(child.childId, "safe".repeat(5000));
  const item = h.store
    .readItemPage(child.childId, h.store.headSeq() + 1, 20)
    .items.find((entry) => entry.type === "message" && entry.role === "assistant");
  const source =
    item?.type === "message" ? item.parts.find((part) => part.type === "text") : undefined;
  if (source?.type !== "text" || !source.source) throw new Error("Large result source missing");
  const port = createAgentControlPort(h.store, h.service);
  const page = await port.execute(
    parent,
    {
      op: "thread.read_output",
      threadId: child.childId,
      streamId: source.source.streamId,
      offset: 0,
      limit: 800,
    },
    new AbortController().signal,
  );
  const data = z.object({ bytes: z.string(), nextOffset: z.number() }).parse(page.data);
  expect(Buffer.from(data.bytes, "base64").toString("utf16le")).toBe("safe".repeat(100));
  expect(data.nextOffset).toBe(800);
  expect(
    await port.execute(
      parent,
      {
        op: "thread.read_output",
        threadId: parent.threadId,
        streamId: source.source.streamId,
        offset: 0,
        limit: 800,
      },
      new AbortController().signal,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
});

test("a rejected delegation expiry backs off while an unrelated child result still wakes its parent", async () => {
  const h = setup({ durationMs: 100, coalesceMs: 10 });
  const failing = await h.parent();
  const healthy = await h.parent();
  h.delegate(failing, "stuck");
  const done = h.delegate(healthy, "done");
  await h.engine.flush();
  await h.complete(done.childId, "delivered");
  h.store.atomic((db) =>
    db.exec(
      `CREATE TRIGGER reject_expiry BEFORE UPDATE OF cancelled ON delegation_trees WHEN NEW.root_id='${failing.threadId}' BEGIN SELECT RAISE(ABORT, 'expiry rejected'); END`,
    ),
  );
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, healthy.threadId)).toHaveLength(1);
  expect(h.errors.map(String).filter((error) => error.includes("expiry rejected"))).toHaveLength(1);
  h.clock.advance(1101);
  await h.engine.flush();
  expect(h.errors.map(String).filter((error) => error.includes("expiry rejected"))).toHaveLength(1);
});
