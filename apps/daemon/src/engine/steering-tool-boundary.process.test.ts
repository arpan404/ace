import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

type Harness = ReturnType<typeof transitionHarness>;

/** The root's turn is running `build` in the foreground. */
async function runningCommand(h: Harness): Promise<ThreadId> {
  const id = await h.create();
  h.held.add(id);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
  await h.engine.flush();
  h.emit(id, {
    type: "item.upsert",
    agent: "root",
    item: "build",
    draft: {
      type: "tool_call",
      complete: false,
      call: { title: "Build", status: "running", detail: { kind: "shell", command: "build" } },
    },
  });
  await h.engine.flush();
  return id;
}

const send = (h: Harness, id: ThreadId, text: string, delivery: "steer" | "queue") =>
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text }], delivery });

const finishBuild = (h: Harness, id: ThreadId) =>
  h.emit(id, {
    type: "item.upsert",
    agent: "root",
    item: "build",
    draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
  });

const endedRuns = (h: Harness, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).runs).filter((run) => run.state !== "active");

test("a steer the provider takes mid-tool goes straight in while the command runs; queue mode waits", async () => {
  const h = transitionHarness();
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(send(h, id, "steer", "steer").ok).toBe(true);
    expect(send(h, id, "queue", "queue").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([{ text: "steer", delivery: "steer" }]);
    expect(h.interrupts).toEqual([]);
    expect(h.engine.queue(id).messages.map((message) => message.input)).toEqual([
      [{ type: "text", text: "queue" }],
    ]);
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
    await h.engine.flush();
    expect(h.inputs.slice(before).map((input) => input.text)).toEqual(["steer", "queue"]);
  } finally {
    await h.close();
  }
});

test("a steer while a command is running interrupts it and the model receives the message next", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", interruptEndsTurn: true });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(send(h, id, "Look at the log instead", "steer").ok).toBe(true);
    expect(send(h, id, "After that", "queue").ok).toBe(true);
    await h.engine.flush();
    // Only the root turn stops: background work and children are not cascaded.
    expect(h.interrupts).toEqual([{ threadId: id, cascade: false }]);
    expect(h.inputs.slice(before).map((input) => input.text)).toEqual(["Look at the log instead"]);
    expect(h.engine.queue(id)).toMatchObject({ paused: false });
    expect(h.engine.queue(id).messages.map((message) => message.input)).toEqual([
      [{ type: "text", text: "After that" }],
    ]);
    // The cut-short turn made way for the steer: it reads as that, never as a stop.
    expect(endedRuns(h, id).at(-1)).toMatchObject({ state: "interrupted", endedBy: "steer" });
    expect(h.store.getThread(id)?.status.state).toBe("working");
    const items = Object.values(h.store.snapshotThread(id).items);
    expect(
      items.filter(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          item.parts.some(
            (part) => part.type === "text" && part.text === "Look at the log instead",
          ),
      ),
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("the thread stays working while the interrupted turn winds down, and the steer goes in once it ends", async () => {
  const h = transitionHarness({ steerTiming: "after_tool" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(send(h, id, "Stop tailing that", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.interrupts).toHaveLength(1);
    expect(h.inputs.slice(before)).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("working");
    // The command settling first doesn't let the steer slip into the turn that is ending.
    finishBuild(h, id);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toEqual([]);
    expect(h.interrupts).toHaveLength(1);
    expect(h.store.getThread(id)?.status.state).not.toBe("done");
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "interrupted" });
    await h.engine.flush();
    expect(h.inputs.slice(before).map((input) => input.text)).toEqual(["Stop tailing that"]);
    expect(h.engine.queue(id).messages).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("working");
  } finally {
    await h.close();
  }
});

test("a delegated result never interrupts a running command; it steers once the command ends", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", interruptEndsTurn: true });
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
    expect(h.interrupts).toEqual([]);
    expect(h.inputs.slice(before)).toEqual([]);
    finishBuild(h, id);
    await h.engine.flush();
    expect(h.interrupts).toEqual([]);
    expect(h.inputs.slice(before)).toMatchObject([{ text: "child result", delivery: "steer" }]);
  } finally {
    await h.close();
  }
});

test("a Stop during the interrupt wins: the turn reads stopped and the steer waits for the person", async () => {
  const h = transitionHarness({ steerTiming: "after_tool" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(send(h, id, "Try the other path", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
    await h.engine.flush();
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "interrupted" });
    await h.engine.flush();
    expect(endedRuns(h, id).at(-1)).toMatchObject({ state: "interrupted" });
    expect(endedRuns(h, id).at(-1)?.endedBy).toBeUndefined();
    expect(h.inputs.slice(before)).toEqual([]);
    expect(h.engine.queue(id).messages).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("a steer interrupted by a daemon restart is delivered once", async () => {
  const h = transitionHarness({ steerTiming: "after_tool" });
  try {
    const id = await runningCommand(h);
    expect(send(h, id, "Use the cached build", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.interrupts).toHaveLength(1);
    await h.restart();
    await h.engine.flush();
    const before = h.inputs.length;
    // Nothing starts by itself after a restart; the steer is kept, never marked uncertain.
    expect(h.engine.queue(id)).toMatchObject({ paused: true });
    expect(h.engine.queue(id).messages).toMatchObject([
      { input: [{ type: "text", text: "Use the cached build" }], state: "queued" },
    ]);
    h.held.delete(id);
    expect(
      h.command({
        type: "queue.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(
      h.inputs.slice(before).filter((input) => input.text === "Use the cached build"),
    ).toHaveLength(1);
    expect(h.engine.queue(id).messages).toEqual([]);
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Use the cached build")).toHaveLength(1);
  } finally {
    await h.close();
  }
});
