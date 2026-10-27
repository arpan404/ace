import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function parentAgent(
  h: ReturnType<typeof transitionHarness>,
  id: Awaited<ReturnType<typeof h.create>>,
) {
  const parent = h.store.getThread(id)?.rootAgentId;
  if (!parent) throw new Error("Missing root");
  return parent;
}

test("switching a limited parent continues its limited delegated child once on the replacement", async () => {
  const options = { limited: true, recovery: { resetAt: () => 5000 } };
  const h = transitionHarness(options);
  cleanup.push(h.close);
  const parent = await h.create();
  const child = await h.create();
  const childThread = h.store.getThread(child);
  if (!childThread) throw new Error("Missing child");
  h.engine.attachChild(parent, parentAgent(h, parent), childThread, "worker", false);
  options.limited = false;
  const request = {
    type: "thread.switch" as const,
    threadId: parent,
    selection: { provider: "claude" as const },
  };
  expect(h.command(request, "recover-tree").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(child)).toMatchObject({ provider: "claude", status: { state: "done" } });
  const sent = h.inputs.filter((input) => input.threadId === child && input.provider === "claude");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain("existing delegated task");
  expect(h.command(request, "recover-tree").ok).toBe(true);
  await h.engine.flush();
  expect(
    h.inputs.filter((input) => input.threadId === child && input.provider === "claude"),
  ).toHaveLength(1);
});

test("switching the parent leaves an independently working child on its current provider", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const parent = await h.create();
  const child = await h.create();
  h.held.add(child);
  h.command({
    type: "thread.send",
    threadId: child,
    input: [{ type: "text", text: "keep working" }],
  });
  await h.engine.flush();
  const childThread = h.store.getThread(child);
  if (!childThread) throw new Error("Missing child");
  h.engine.attachChild(parent, parentAgent(h, parent), childThread, "worker", false);
  h.command({ type: "thread.switch", threadId: parent, selection: { provider: "claude" } });
  await h.engine.flush();
  expect(h.store.getThread(parent)?.switch?.state).toBe("applied");
  expect(h.store.getThread(parent)?.status.state).not.toBe("done");
  expect(
    Object.values(h.store.snapshotThread(parent).agents).some(
      (agent) => agent.childThreadId === child,
    ),
  ).toBe(true);
  expect(h.store.getThread(child)).toMatchObject({
    provider: "codex",
    status: { state: "working" },
  });
  expect(h.sessions.findLast((session) => session.context.threadId === child)?.closed).toBe(false);
});

test("Stop preserves a selected replacement while keeping messages held", async () => {
  const h = transitionHarness({ interruptEndsTurn: true });
  cleanup.push(h.close);
  const id = await h.create();
  h.held.add(id);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "old turn" }] });
  await h.engine.flush();
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  await h.engine.flush();
  expect(h.store.getThread(id)).toMatchObject({ provider: "claude", switch: { state: "applied" } });
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "stopped" });
  expect(h.inputs.filter((input) => input.provider === "claude")).toHaveLength(0);
});

test("the replacement receives unfinished native work in its durable handoff", async () => {
  const options = { limited: true, recovery: { resetAt: () => 5000 } };
  const h = transitionHarness(options);
  cleanup.push(h.close);
  const id = await h.create();
  h.emit(id, {
    type: "background.started",
    agent: "root",
    task: "build",
    kind: "shell",
    title: "Compile release",
    stoppable: true,
  });
  await h.engine.flush();
  options.limited = false;
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  await h.reopen();
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "continue" }] });
  await h.engine.flush();
  const input = h.inputs.findLast((entry) => entry.provider === "claude");
  expect(input?.text).toContain("Execution recovery after switching providers");
  expect(input?.text).toContain("Compile release");
  expect(input?.text).toContain("no completion is implied");
});

test("changing models releases the old model's quota hold without changing accounts", async () => {
  const options = { limited: true, recovery: { resetAt: () => 5000 } };
  const h = transitionHarness(options);
  cleanup.push(h.close);
  const id = await h.create();
  options.limited = false;
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", model: "model-b" },
  });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "try the replacement model" }],
  });
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({ provider: "codex", model: "model-b" });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
});

test("Stop clears the execution's quota hold and prevents its reset timer from continuing", async () => {
  const h = transitionHarness({
    limited: true,
    preferences: { limitPolicy: "resume_at_reset" },
    recovery: { resetAt: () => 5000 },
  });
  cleanup.push(h.close);
  const id = await h.create();
  h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).not.toBe("limited");
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "stopped", resumeAt: null });
  h.clock.advance(5000);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(1);
});

test("a source that refuses to close leaves both parent and child on their original provider", async () => {
  const h = transitionHarness({
    limited: true,
    closeFails: true,
    recovery: { resetAt: () => 5000 },
  });
  cleanup.push(h.close);
  const parent = await h.create();
  const child = await h.create();
  const childThread = h.store.getThread(child);
  if (!childThread) throw new Error("Missing child");
  h.engine.attachChild(parent, parentAgent(h, parent), childThread, "worker", false);
  h.command({ type: "thread.switch", threadId: parent, selection: { provider: "claude" } });
  await h.engine.flush();
  expect(h.store.getThread(parent)).toMatchObject({
    provider: "codex",
    switch: { state: "failed" },
  });
  expect(h.store.getThread(child)?.provider).toBe("codex");
  expect(h.inputs.filter((input) => input.provider === "claude")).toHaveLength(0);
});
