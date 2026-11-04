import { expect, test } from "vitest";
import { setup } from "./test-support.ts";
import { end } from "../engine/test-support.ts";

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
