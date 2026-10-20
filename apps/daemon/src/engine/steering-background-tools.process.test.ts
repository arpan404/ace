import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

// Claude holds a steer until the running foreground tool returns, but can move that tool to the
// background (Ctrl+B) without stopping it. A person's steer must reach the model now; nothing
// running may be interrupted.

type Harness = ReturnType<typeof transitionHarness>;

/** A Claude thread whose root turn is running `wait-for-build` in the foreground. */
async function runningCommand(h: Harness): Promise<ThreadId> {
  const id = await h.create(undefined, "claude");
  h.held.add(id);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
  await h.engine.flush();
  h.emit(id, {
    type: "item.upsert",
    agent: "root",
    item: "wait-for-build",
    draft: {
      type: "tool_call",
      complete: false,
      call: {
        title: "Wait for build",
        status: "running",
        detail: { kind: "shell", command: "until grep -q '^exit ' log; do sleep 30; done" },
      },
    },
  });
  await h.engine.flush();
  return id;
}

const steer = (h: Harness, id: ThreadId, text: string) =>
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text }], delivery: "steer" });

const activeRuns = (h: Harness, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).runs).filter((run) => run.state === "active");

test("a person's steer during a running command goes in now and the command moves to the background instead of stopping", async () => {
  const h = transitionHarness({ backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(steer(h, id, "Skip the wait, check the log").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Skip the wait, check the log", delivery: "steer" },
    ]);
    // The steer is already with the provider when its tools move, so it is taken at that boundary.
    expect(h.backgroundRequests).toEqual([{ threadId: id, inputsBefore: before + 1 }]);
    expect(h.interrupts).toEqual([]);
    expect(activeRuns(h, id)).toHaveLength(1);
    expect(h.store.getThread(id)?.status.state).toBe("working");
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a delegated result never moves the running command to the background; it waits for it", async () => {
  const h = transitionHarness({ backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    const result = h.internalCommand({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "child result" }],
      delivery: "steer",
      trigger: "subagent_result",
      origin: { kind: "subagent_result", threadIds: [id] },
    });
    expect(result.ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toEqual([]);
    h.emit(id, {
      type: "item.upsert",
      agent: "root",
      item: "wait-for-build",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([{ text: "child result", delivery: "steer" }]);
    expect(h.backgroundRequests).toEqual([]);
    expect(h.interrupts).toEqual([]);
  } finally {
    await h.close();
  }
});

test("when the provider can't background its tools, the steer still goes in and nothing is interrupted", async () => {
  const h = transitionHarness({ backgroundTools: "fails" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(steer(h, id, "Use the cached build").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Use the cached build", delivery: "steer" },
    ]);
    expect(h.backgroundRequests).toHaveLength(1);
    expect(h.errors).toMatchObject([{ message: "Background tasks are disabled" }]);
    expect(h.interrupts).toEqual([]);
    expect(activeRuns(h, id)).toHaveLength(1);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("working");
  } finally {
    await h.close();
  }
});

test("a steer between turns starts the next turn without backgrounding anything", async () => {
  const h = transitionHarness({ backgroundTools: "moves" });
  try {
    const id = await h.create(undefined, "claude");
    const before = h.inputs.length;
    expect(steer(h, id, "One more thing").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([{ text: "One more thing" }]);
    expect(h.backgroundRequests).toEqual([]);
  } finally {
    await h.close();
  }
});
