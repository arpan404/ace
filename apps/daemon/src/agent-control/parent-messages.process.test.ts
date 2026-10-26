import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { McpAttribution, ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { setup } from "./test-support.ts";
import { task } from "../engine/test-support.ts";

type Harness = ReturnType<typeof setup>;

/** A delegated child whose first turn is still running. */
async function runningChild(steer: boolean, steeringMode?: "interrupt-restart") {
  const none = undefined;
  const h = setup({}, none, false, none, false, none, none, none, none, none, steer, steeringMode);
  const parent = await h.parent();
  const child = h.delegate(parent, "worker");
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  return { h, parent, child: child.childId };
}

const message = (
  h: Harness,
  parent: McpAttribution,
  threadId: ThreadId,
  text: string,
  delivery?: "queue" | "steer" | "restart",
  requestId = `message-${text.length}`,
) =>
  createAgentControlPort(h.store, h.service).execute(
    parent,
    { op: "thread.message", threadId, requestId, text, ...(delivery ? { delivery } : {}) },
    new AbortController().signal,
  );

const received = (h: Harness, id: ThreadId) => h.inputs.get(id) ?? [];
const later = (h: Harness, ms: number) => h.clock.advance(h.clock.now() + ms);

test("a parent's message reaches its running child's turn now when the provider steers", async () => {
  const { h, parent, child } = await runningChild(true);
  const sent = await message(h, parent, child, "New repo rule");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "steering" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("New repo rule");
  expect(h.inputMessages.get(child)?.at(-1)).toMatchObject({ delivery: "steer" });
  // The child's turn goes on with the message in it: nothing reads it as done.
  expect(h.store.getThread(child)?.status.state).toBe("working");
});

test("on a provider whose steer restarts the turn, the parent is told the turn restarts", async () => {
  const { h, parent, child } = await runningChild(true, "interrupt-restart");
  const sent = await message(h, parent, child, "New repo rule");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "restarting" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("New repo rule");
});

test("a parent's message to a child that can't steer says it waits, then runs when the turn ends", async () => {
  const { h, parent, child } = await runningChild(false);
  const sent = await message(h, parent, child, "New repo rule");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "queued" } });
  await h.engine.flush();
  expect(received(h, child)).not.toContain("New repo rule");
  expect(h.service.monitor.snapshot(parent).children).toMatchObject([
    { id: child, state: "working", queued: 1 },
  ]);
  await h.complete(child, "first pass");
  expect(received(h, child)).toContain("New repo rule");
  // The child is on the parent's message now; its first answer is not its result.
  expect(h.store.getThread(child)?.status.state).toBe("working");
  expect(h.service.journal.get(child)?.phase).not.toBe("settled");
});

test("a parent's message starts the child's next turn while its background command keeps running", async () => {
  const { h, parent, child } = await runningChild(true);
  await h.emit(child, task);
  await h.complete(child, "Started the dev server");
  expect(h.store.getThread(child)?.status).toEqual({ state: "waiting", on: "background_task" });
  const sent = await message(h, parent, child, "Now run the tests", "queue");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("Now run the tests");
  expect(h.stoppedTasks).toEqual([]);
});

test("a settled child its parent messages again reads working, never its old result", async () => {
  const { h, parent, child } = await runningChild(true);
  await h.complete(child, "first pass");
  later(h, 1050);
  await h.engine.flush();
  expect(h.service.journal.get(child)?.phase).toBe("settled");
  const sent = await message(h, parent, child, "Also update the docs");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  // Before the provider has taken the message, nothing reports the child finished.
  expect(h.service.monitor.snapshot(parent).children).toMatchObject([
    { id: child, state: "working" },
  ]);
  const waiting = h.service.monitor.wait(
    parent,
    { threadIds: [child], mode: "all", timeoutSeconds: 1 },
    new AbortController().signal,
  );
  later(h, 1000);
  expect(await waiting).toMatchObject({ ok: true, data: { status: "timeout" } });
});

test("a child that failed takes its parent's next message as a new turn", async () => {
  const { h, parent, child } = await runningChild(true);
  await h.emit(child, { type: "turn.ended", agent: "root", outcome: "failed" });
  expect(h.store.getThread(child)?.status.state).toBe("failed");
  const sent = await message(h, parent, child, "Try the other approach");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("Try the other approach");
});

for (const on of ["rate_limit", "network"] as const)
  test(`a message to a child whose provider waits on ${on} says so and doesn't start a turn`, async () => {
    const { h, parent, child } = await runningChild(true);
    await h.emit(child, { type: "retry", agent: "root", on, message: "Waiting on the provider" });
    expect(h.store.getThread(child)?.status.state).not.toBe("working");
    const sent = await message(h, parent, child, "Keep going", "queue");
    expect(sent).toMatchObject({ ok: true, data: { arrival: "queued" } });
    await h.engine.flush();
    expect(received(h, child)).not.toContain("Keep going");
  });

test("a message to a child whose queue the person paused is held", async () => {
  const { h, parent, child } = await runningChild(true);
  const paused = h.service.command(randomUUID(), {
    type: "queue.pause",
    threadId: child,
    expectedRevision: h.engine.queue(child).revision,
  });
  expect(paused.ok).toBe(true);
  expect(await message(h, parent, child, "Later work", "queue")).toMatchObject({
    ok: true,
    data: { arrival: "held" },
  });
});

test("a restart stops the child's turn and starts the next one with the message", async () => {
  const { h, parent, child } = await runningChild(true);
  const sent = await message(h, parent, child, "Start over on main", "restart");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  await h.engine.flush();
  expect(received(h, child).at(-1)).toBe("Start over on main");
});

test("a message the person removed from the child's queue is refused on retry, with why", async () => {
  const { h, parent, child } = await runningChild(false);
  await message(h, parent, child, "Rename the module", "queue", "rename");
  const queue = h.engine.queue(child);
  const queued = queue.messages[0];
  if (!queued) throw new Error("Nothing queued");
  const removed = h.service.command(randomUUID(), {
    type: "queue.remove",
    threadId: child,
    messageId: queued.id,
    expectedRevision: queue.revision,
  });
  expect(removed.ok).toBe(true);
  const retried = await message(h, parent, child, "Rename the module", "queue", "rename");
  expect(retried).toMatchObject({ ok: false, hint: expect.stringContaining("removed") });
});

test("a message to a thread that isn't the agent's child waits for its turn by default", async () => {
  const { h, parent } = await runningChild(true);
  const workspaceId = h.store.getThread(parent.threadId)?.workspaceId;
  if (!workspaceId) throw new Error("No workspace");
  const other = h.service.command(randomUUID(), {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    input: [{ type: "text", text: "The person's own work" }],
  });
  if (!other.ok || !other.threadId) throw new Error("No thread");
  await h.engine.flush();
  expect(await message(h, parent, other.threadId, "Pick this up")).toMatchObject({
    ok: true,
    data: { arrival: "queued" },
  });
  await h.engine.flush();
  expect(received(h, other.threadId)).not.toContain("Pick this up");
});

test("a steer the provider refuses as the turn ends is kept for the next turn and the parent is told", async () => {
  const { h, parent, child } = await runningChild(true);
  h.failNextSend("rejected");
  expect(await message(h, parent, child, "New repo rule")).toMatchObject({
    ok: true,
    data: { arrival: "steering" },
  });
  await h.engine.flush();
  expect(received(h, child)).not.toContain("New repo rule");
  // The parent hears it as it hears results, and agents_status shows it.
  expect(received(h, parent.threadId).join("\n")).toContain("couldn't join its running turn");
  expect(h.service.monitor.snapshot(parent).children).toMatchObject([
    { id: child, notice: expect.stringContaining("runs when that turn ends") },
  ]);
  // A retry while it waits says so; its bubble no longer belongs to the turn it missed.
  expect(await message(h, parent, child, "New repo rule")).toMatchObject({
    ok: true,
    data: { arrival: "queued" },
  });
  const bubble = Object.values(h.store.snapshotThread(child).items).find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.parts.some((part) => part.type === "text" && part.text === "New repo rule"),
  );
  expect(bubble).toBeDefined();
  expect(bubble && "runId" in bubble ? bubble.runId : undefined).toBeUndefined();
  await h.complete(child, "first pass");
  expect(received(h, child).filter((text) => text === "New repo rule")).toHaveLength(1);
  // Once the child has it, the notice is no longer news.
  expect(h.service.monitor.snapshot(parent).children[0]?.notice).toBeUndefined();
});

test("a queued message the provider refuses unread waits for the person and is never resent in a loop", async () => {
  const { h, parent, child } = await runningChild(false);
  await message(h, parent, child, "Use the new API");
  h.failNextSend("rejected", "queue");
  await h.complete(child, "first pass");
  later(h, 5000);
  await h.engine.flush();
  const tries = h.attempts.filter((entry) => entry.text === "Use the new API");
  expect(tries).toHaveLength(1);
  expect(h.engine.queue(child)).toMatchObject({ paused: true, reason: "not_sent" });
  expect(received(h, parent.threadId).join("\n")).toContain("wasn't sent");
});

test("a steer lost in transit is never resent, and the parent is told it may not have arrived", async () => {
  const { h, parent, child } = await runningChild(true);
  h.failNextSend("lost");
  await message(h, parent, child, "New repo rule");
  await h.engine.flush();
  expect(received(h, parent.threadId).join("\n")).toContain("may or may not have reached it");
  // A retry of the same request says it waits on the person, never that it is on its way.
  expect(await message(h, parent, child, "New repo rule")).toMatchObject({
    ok: true,
    data: { arrival: "held" },
  });
  await h.complete(child, "first pass");
  expect(received(h, child)).not.toContain("New repo rule");
});
