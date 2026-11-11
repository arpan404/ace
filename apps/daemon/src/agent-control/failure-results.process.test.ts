import { expect, test, vi } from "vitest";
import { MonitorSnapshot } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";
import { end, question, start } from "../engine/test-support.ts";

test("a failed child without an answer returns its provider error to its parent", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  await h.emit(child.childId, {
    ...end,
    outcome: "failed",
    error: { kind: "provider", code: "process_exit", message: "Provider exited with status 7" },
  });
  const result = await h.service.wait(parent, child.childId, new AbortController().signal);
  expect(result.outcome).toBe("failed");
  expect(result.result).toContain("Provider exited with status 7");
});

test("a child stopped on a usage limit settles and notifies without a cancel", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  await h.emit(
    child.childId,
    { type: "retry", agent: "root", on: "rate_limit", until: 5000, message: "Quota exhausted" },
    { ...end, outcome: "failed", error: { kind: "quota", message: "Quota exhausted" } },
  );
  expect(h.service.monitor.snapshot(parent).children).toContainEqual(
    expect.objectContaining({
      id: child.childId,
      state: "failed",
      failure: expect.objectContaining({ code: "usage_limited", resetsAt: 5000 }),
    }),
  );
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain("Usage limit reached");
  const result = await h.service.wait(parent, child.childId, new AbortController().signal);
  expect(result.failure?.code).toBe("usage_limited");
});

test("a limit never settles a child while its background work is still running", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  await h.emit(
    child.childId,
    {
      type: "background.started",
      agent: "root",
      task: "shell",
      kind: "shell",
      title: "Checking",
      stoppable: true,
    },
    { type: "retry", agent: "root", on: "rate_limit", until: 5000, message: "Quota exhausted" },
    { ...end, outcome: "failed", error: { kind: "quota", message: "Quota exhausted" } },
  );
  expect(h.store.getThread(child.childId)?.status.state).toBe("limited");
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("working");
  await h.emit(child.childId, { type: "background.ended", task: "shell", status: "completed" });
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("failed");
});

const none = undefined;
type Recovery = Parameters<typeof setup>[12];
const withRecovery = (recovery: Recovery) =>
  setup({}, none, false, none, false, none, none, none, none, none, false, none, recovery);
const quota = { kind: "quota", message: "Quota exhausted" } as const;
const stopsOnLimit = (until: number) =>
  [
    { type: "retry", agent: "root", on: "rate_limit", until, message: "Quota exhausted" },
    { ...end, outcome: "failed", error: quota },
  ] as const;

test("a child ace resumes at its reset stays open, and its parent hears when it resumes instead of a failure", async () => {
  const h = withRecovery({ preferences: { limitPolicy: "resume_at_reset" } });
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const reset = h.clock.now() + 60_000;
  await h.emit(child.childId, ...stopsOnLimit(reset));
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("working");
  expect(h.service.journal.get(child.childId)?.phase).toBe("running");
  const told = h.inputs.get(parent.threadId)?.join("\n") ?? "";
  expect(told).toContain(`ace resumes it at ${new Date(reset).toISOString()}`);
  expect(told).not.toContain("usage_limited");
  // At the reset ace carries it on by itself.
  const sent = h.inputs.get(child.childId)?.length ?? 0;
  h.clock.advance(reset + 1);
  await h.engine.flush();
  expect(h.inputs.get(child.childId)?.length ?? 0).toBeGreaterThan(sent);
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("working");
});

/** Codex can end the turn on systemError first, and report the usage limit after it. */
const limitAfterEnd = (until: number) =>
  [
    { ...end, outcome: "failed", error: { kind: "provider", message: "systemError" } },
    { type: "retry", agent: "root", on: "rate_limit", until, message: "Quota exhausted" },
  ] as const;

test("a limit reported after the child's turn already ended still tells its parent that ace resumes it", async () => {
  const h = withRecovery({ preferences: { limitPolicy: "resume_at_reset" } });
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const reset = h.clock.now() + 60_000;
  for (const fact of limitAfterEnd(reset)) await h.emit(child.childId, fact);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain(
    `ace resumes it at ${new Date(reset).toISOString()}`,
  );
  expect(h.service.journal.get(child.childId)?.phase).toBe("running");
});

test("a limit reported just after the child's turn ended settles it as usage limited when nothing resumes it", async () => {
  const h = withRecovery({});
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  await h.emit(child.childId, ...limitAfterEnd(h.clock.now() + 60_000));
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(h.service.monitor.snapshot(parent).children[0]).toMatchObject({
    state: "failed",
    failure: { code: "usage_limited" },
  });
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain("usage_limited");
});

const settledNotices = (h: ReturnType<typeof withRecovery>, parent: { threadId: string }) =>
  (h.inputs.get(parent.threadId as never) ?? []).filter((text) =>
    text.includes("delegation.settled"),
  );

test("a limit reported a moment after the turn ended replaces the bare failure the parent was about to hear", async () => {
  const h = withRecovery({});
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const [ended, limit] = limitAfterEnd(h.clock.now() + 60_000);
  await h.emit(child.childId, ended);
  await h.emit(child.childId, limit);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(settledNotices(h, parent)).toHaveLength(1);
  expect(settledNotices(h, parent)[0]).toContain("usage_limited");
  expect(h.service.monitor.snapshot(parent).children[0]).toMatchObject({
    state: "failed",
    failure: { code: "usage_limited" },
  });
});

test("a limit reported after the parent already heard a bare failure tells it the reason once", async () => {
  const h = withRecovery({});
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const [ended, limit] = limitAfterEnd(h.clock.now() + 60_000);
  await h.emit(child.childId, ended);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(settledNotices(h, parent)).toHaveLength(1);
  expect(settledNotices(h, parent)[0]).not.toContain("usage_limited");

  await h.emit(child.childId, limit);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(settledNotices(h, parent)).toHaveLength(2);
  expect(settledNotices(h, parent)[1]).toContain("usage_limited");
  expect(h.service.monitor.snapshot(parent).children[0]).toMatchObject({
    state: "failed",
    failure: { code: "usage_limited" },
  });
  // The limit staying in place tells it nothing more.
  await h.emit(child.childId, limit);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(settledNotices(h, parent)).toHaveLength(2);
});

test("a child is never settled while its limit policy is still loading, and settles once it loads as manual", async () => {
  const { promise: loaded, resolve: release } = Promise.withResolvers<void>();
  let gated = false;
  const h = withRecovery({
    recovery: {
      preferences: async () => {
        if (gated) await loaded;
        return { followUpBehavior: "queue", limitPolicy: "manual" };
      },
    },
  });
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  gated = true;
  // Emitted without a flush: a flush waits for the policy this test holds back.
  h.contexts.get(child.childId)?.onFrame(h.frames.frame(...stopsOnLimit(h.clock.now() + 60_000)));
  await vi.waitFor(() => expect(h.store.getThread(child.childId)?.status.state).toBe("limited"));
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(h.service.journal.get(child.childId)?.phase).toBe("running");
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("working");
  release();
  await h.engine.flush();
  expect(h.service.monitor.snapshot(parent).children[0]).toMatchObject({
    state: "failed",
    failure: { code: "usage_limited" },
  });
});

test("a person's resume after the reset revives a child settled on its limit, and its next stop settles again with a new notice", async () => {
  const h = withRecovery({});
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const reset = h.clock.now() + 60_000;
  await h.emit(child.childId, ...stopsOnLimit(reset));
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  const notices = () =>
    (h.inputs.get(parent.threadId) ?? []).filter((text) => text.includes("usage_limited"));
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("failed");
  expect(notices()).toHaveLength(1);

  h.clock.advance(reset + 1);
  await h.engine.flush();
  const resumed = h.service.command(`resume-${child.childId}`, {
    type: "thread.resume",
    threadId: child.childId,
    expectedRevision: h.engine.queue(child.childId).revision,
  });
  expect(resumed.ok).toBe(true);
  await h.engine.flush();
  await h.emit(child.childId, start);
  expect(h.service.journal.get(child.childId)?.phase).not.toBe("settled");
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("working");

  await h.emit(child.childId, ...stopsOnLimit(reset + 60_000));
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("failed");
  expect(notices()).toHaveLength(2);
});

test("a child stopped on its limit while a request waits on the person is never settled", async () => {
  const h = withRecovery({});
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  // The provider reports the stop and a request on the person in one batch.
  await h.emit(child.childId, ...stopsOnLimit(h.clock.now() + 60_000), question);
  h.clock.advance(h.clock.now() + 1_050);
  await h.engine.flush();
  expect(h.service.journal.get(child.childId)?.phase).toBe("running");
  expect(h.service.monitor.snapshot(parent).children[0]?.state).toBe("needs_you");
});

test("agents_status lists the start of a settled child's result; reading that child gives all of it", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  const answer = `Reviewed. ${"Every finding is fixed. ".repeat(40)}The end.`;
  await h.complete(child.childId, answer);
  const port = createAgentControlPort(h.store, h.service);
  const signal = new AbortController().signal;

  const listed = MonitorSnapshot.parse(
    (await port.execute(parent, { op: "agents.status" }, signal)).data,
  ).children.find((row) => row.id === child.childId);
  expect(listed?.state).toBe("done");
  expect(listed?.result?.startsWith("Reviewed. Every finding is fixed.")).toBe(true);
  expect(listed?.result?.length).toBeLessThanOrEqual(200);

  const read = await port.execute(parent, { op: "agent.status", threadId: child.childId }, signal);
  expect(read.data).toMatchObject({ outcome: { result: answer } });
});
