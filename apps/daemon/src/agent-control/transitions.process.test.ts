import { expect, test } from "vitest";
import { transitionHarness } from "../engine/transition-test-support.ts";
import { setup, wakes } from "./test-support.ts";

// Fork lineage points at history; only delegate_task creates a cancellation/accounting edge.
test("forks own independent delegations even while the source still has live children", async () => {
  const h = setup();
  const source = await h.parent();
  const point = Object.values(h.store.snapshotThread(source.threadId).runs).find(
    (run) => run.state === "completed",
  );
  if (!point) throw new Error("Missing source boundary");
  const sourceChild = h.delegate(source, "source-child");
  await h.engine.flush();
  const result = h.service.command("fork-source", {
    type: "thread.fork",
    threadId: source.threadId,
    point: { type: "turn", runId: point.id },
    input: "Independent continuation",
    budgetBytes: 4096,
  });
  expect(result.ok).toBe(true);
  if (!result.forkThreadId) throw new Error("Missing fork identity");
  await h.engine.flush();
  const fork = h.caller(result.forkThreadId);
  expect(h.store.getThread(fork.threadId)?.lineage?.parentThreadId).toBe(source.threadId);
  expect(h.store.getThread(fork.threadId)?.status.state).toBe("done");
  expect(Object.values(h.store.snapshotThread(fork.threadId).agents)).toHaveLength(1);
  const forkChild = h.delegate(fork, "fork-child");
  await h.engine.flush();
  h.service.cancelDescendants(fork.threadId, "stop-fork-tree");
  await h.engine.flush();
  expect(await h.service.wait(fork, forkChild.childId, new AbortController().signal)).toMatchObject(
    {
      outcome: "cancelled",
    },
  );
  expect(h.store.getThread(sourceChild.childId)?.status.state).toBe("working");
  await h.complete(sourceChild.childId, "source result");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, source.threadId)).toHaveLength(1);
  expect(wakes(h.events, fork.threadId)).toHaveLength(0);
  expect(h.inputs.get(source.threadId)?.join("\n")).toContain("source result");
  expect(h.errors).toEqual([]);
});

test("switching a delegated thread keeps its parent, history edge and follow-up admission", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const child = h.delegate(parent, "switched-child");
  await h.engine.flush();
  await h.complete(child.childId, "first completion");
  const root = h.caller(child.childId).agentId;
  expect(
    h.service.command("switch-child", {
      type: "thread.switch",
      threadId: child.childId,
      selection: { provider: "codex", options: {} },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.switch?.state).toBe("applied");
  expect(h.caller(child.childId).agentId).toBe(root);
  expect(
    h.service.message(parent, "continue-switched-child", child.childId, "next result", "queue").ok,
  ).toBe(true);
  // Admission happens synchronously, before the provider can finish the follow-up.
  expect(() => h.delegate(parent, "over-capacity")).toThrow("concurrency_limit");
  await h.engine.flush();
  expect(h.contexts.get(child.childId)?.options).toEqual({});
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
  const linked = Object.values(h.store.snapshotThread(parent.threadId).agents).filter(
    (agent) => agent.childThreadId === child.childId,
  );
  expect(linked).toHaveLength(1);
  expect(linked[0]?.parentId).toBe(parent.agentId);
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain(child.childId);
  const prepared = h.service.prepare(h.caller(child.childId), {
    requestId: "grandchild-after-switch",
    provider: "claude",
    role: "reviewer",
    task: "review",
    wait: false,
    estimatedLoad: 0,
  });
  h.service.cancelDescendants(parent.threadId, "cancel-original-owner");
  await h.engine.flush();
  expect(() => h.service.launch(prepared, "must stay cancelled")).not.toThrow();
  expect(h.contexts.has(prepared.childId)).toBe(false);
  expect(h.errors).toEqual([]);
});

test("a queued switch waits for live delegated children while result wakes can run beside them", async () => {
  const h = setup();
  const parent = await h.parent();
  const first = h.delegate(parent, "first");
  const second = h.delegate(parent, "second");
  await h.engine.flush();
  expect(
    h.service.command("switch-owner-model", {
      type: "thread.switch",
      threadId: parent.threadId,
      selection: { provider: "codex", model: "next-model", options: {} },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.switch?.state).toBe("queued");
  await h.complete(first.childId, "first result");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
  expect(h.store.getThread(parent.threadId)?.switch?.state).toBe("queued");
  expect(h.store.getThread(second.childId)?.status.state).toBe("working");
  await h.complete(second.childId, "second result");
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.switch?.state).toBe("applied");
  expect(h.caller(parent.threadId).agentId).toBe(parent.agentId);
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(2);
  expect(h.contexts.get(parent.threadId)?.model).toBe("next-model");
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain("second result");
  expect(h.errors).toEqual([]);
});

test("cancelling a delegated subtree also cancels its queued provider switch", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "cancel-before-switch");
  await h.engine.flush();
  expect(
    h.service.command("queued-switch", {
      type: "thread.switch",
      threadId: child.childId,
      selection: { provider: "codex", options: {} },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.switch?.state).toBe("queued");
  h.service.cancelDescendants(parent.threadId, "cancel-owner");
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.provider).toBe("claude");
  expect(h.store.getThread(child.childId)?.switch?.state).toBe("failed");
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  expect(h.errors).toEqual([]);
});

test("interrupting a queued whole-session fork releases its source guard without launching it", async () => {
  const h = transitionHarness({ native: true, forkPoints: ["end"] });
  try {
    const source = await h.create();
    const accepted = h.command({
      type: "thread.fork",
      threadId: source,
      point: { type: "turn", runId: h.finishedRun(source).id },
      input: "cancelled fork",
      budgetBytes: 4096,
    });
    if (!accepted.forkThreadId) throw new Error("Missing fork identity");
    expect(
      h.command({ type: "thread.interrupt", threadId: accepted.forkThreadId, cascade: true }).ok,
    ).toBe(true);
    expect(
      h.command({
        type: "thread.send",
        threadId: source,
        input: [{ type: "text", text: "source keeps working" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.sessions.some((session) => session.context.threadId === accepted.forkThreadId)).toBe(
      false,
    );
    expect(h.inputs.at(-1)?.text).toBe("source keeps working");
    expect(h.store.getThread(source)?.status.state).toBe("done");
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});
