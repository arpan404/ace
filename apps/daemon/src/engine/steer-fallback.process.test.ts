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

const agentMessage = (
  h: Harness,
  id: ThreadId,
  text: string,
  delivery: "steer" | "queue",
  commandId = `agent-${text.length}`,
) =>
  h.internalCommand(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text }],
      delivery,
      trigger: "parent_agent",
    },
    commandId,
  );

/** The person presses Steer on a waiting message. */
const steerIn = (h: Harness, id: ThreadId, messageId: string) => {
  const queue = h.engine.queue(id);
  const message = queue.messages.find((entry) => entry.id === messageId);
  if (!message) throw new Error("Not queued");
  return h.command({
    type: "queue.edit",
    threadId: id,
    expectedRevision: queue.revision,
    messageId: message.id,
    input: message.input,
    delivery: "steer",
  });
};

const texts = (h: Harness, from: number) => h.inputs.slice(from).map((input) => input.text);

test("an agent's steer reaches a Claude-like turn at once and leaves the running command alone", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(agentMessage(h, id, "Use the cached build", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Use the cached build", delivery: "steer" },
    ]);
    expect(h.backgroundRequests).toEqual([]);
    expect(h.interrupts).toEqual([]);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

test("the person's Steer on an agent's queued message goes in as their own steer", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(agentMessage(h, id, "Review the docs next", "queue", "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(texts(h, before)).toEqual([]);
    expect(steerIn(h, id, "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Review the docs next", delivery: "steer" },
    ]);
    // Like a steer the person typed, it moves the running command out of its way.
    expect(h.backgroundRequests).toEqual([{ threadId: id, inputsBefore: before + 1 }]);
    expect(h.engine.queue(id).messages).toEqual([]);
    // The transcript still says an agent wrote it.
    expect(h.store.snapshotThread(id).items["input:agent-queued"]).toMatchObject({
      origin: { kind: "parent_agent" },
    });
  } finally {
    await h.close();
  }
});

test("a steer refused because the turn ended falls back to the queue, says so, and goes in once next", async () => {
  const h = transitionHarness();
  try {
    const id = await h.create();
    h.held.add(id);
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
    await h.engine.flush();
    const before = h.inputs.length;
    h.refuseNextSteer();
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "Try the other path" }],
          delivery: "steer",
        },
        "person-steer",
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(texts(h, before)).toEqual([]);
    // Back in the queue as the next message, marked as a steer that couldn't go in.
    expect(h.engine.queue(id)).toMatchObject({
      paused: false,
      messages: [{ id: "person-steer", delivery: "queue", fellBack: true }],
    });
    h.held.delete(id);
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
    await h.engine.flush();
    expect(texts(h, before)).toEqual(["Try the other path"]);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

test("an agent's steer waiting behind a command across a daemon restart is delivered exactly once", async () => {
  // This provider's steer would cut into the command, so ace itself holds the steer.
  const h = transitionHarness();
  try {
    const id = await runningCommand(h);
    expect(agentMessage(h, id, "Use the cached build", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.engine.queue(id).messages).toHaveLength(1);
    const before = h.inputs.length;
    h.held.delete(id);
    await h.restart();
    await h.engine.flush();
    expect(
      h.command({
        type: "thread.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await h.engine.flush();
    expect(texts(h, before).filter((text) => text === "Use the cached build")).toHaveLength(1);
    expect(h.engine.queue(id).messages).toEqual([]);
    await h.restart();
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Use the cached build")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("the person's choice to steer an agent's message survives a restart", async () => {
  const h = transitionHarness();
  try {
    const id = await runningCommand(h);
    expect(agentMessage(h, id, "Review the docs next", "queue", "agent-queued").ok).toBe(true);
    await h.engine.flush();
    // Steered in while the queue can't deliver: the restart below holds it.
    expect(steerIn(h, id, "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Review the docs next")).toHaveLength(1);
    await h.restart();
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Review the docs next")).toHaveLength(1);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});
