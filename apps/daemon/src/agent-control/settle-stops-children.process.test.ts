import { expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { end, question, start, task } from "../engine/test-support.ts";
import { organizeThread } from "../thread-organization.ts";
import { setup } from "./test-support.ts";

/* Settling a thread ends the work of every thread it delegated to, not only its own. */

test("settling a thread stops the child threads it delegated to, with the background work they left running", async () => {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "child", true);
  await f.engine.flush();
  // The child finishes its turn with a background shell still running, and so does the parent.
  await f.emit(child.childId, task, end);
  await f.emit(parent.threadId, end);
  expect(f.store.getThread(child.childId)?.status).toEqual({ state: "done" });
  expect(f.store.getThread(parent.threadId)?.status.state).not.toBe("working");

  const settled = organizeThread(
    f.store,
    Command.parse({
      id: "settle-parent",
      deviceId: "device",
      payload: { type: "thread.settle", threadId: parent.threadId },
    }),
    f.clock.now(),
  );
  expect(settled.ok).toBe(true);
  await f.engine.flush();

  expect(f.engine.liveWork(parent.threadId)).toEqual({ agentsRunning: 0, operationsRunning: 0 });
  expect(f.engine.hasSession(child.childId)).toBe(false);
  expect(f.store.getThread(child.childId)?.status.state).toBe("done");
  expect(
    Object.values(f.store.snapshotThread(child.childId).backgroundTasks).map((t) => t.status),
  ).not.toContain("running");
  expect(f.errors).toEqual([]);
});

/** A parent whose child was stopped by the settle, its "cancelled" result held. */
async function settledWithHeldResult() {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "asks-a-question");
  await f.engine.flush();
  // Blocked on a question, the child leaves its parent settleable.
  await f.emit(child.childId, start, question);
  expect(f.store.getThread(parent.threadId)?.status.state).not.toBe("working");
  const sentBefore = f.inputs.get(parent.threadId)?.length ?? 0;
  const settled = organizeThread(
    f.store,
    Command.parse({
      id: "settle-parent",
      deviceId: "device",
      payload: { type: "thread.settle", threadId: parent.threadId },
    }),
    f.clock.now(),
  );
  expect(settled.ok).toBe(true);
  await f.engine.flush();
  f.clock.advance(f.clock.now() + 5_000);
  await f.engine.flush();
  return { f, parent, sentBefore };
}

const resultsSent = (f: ReturnType<typeof setup>, thread: ThreadId) =>
  (f.inputs.get(thread) ?? []).filter((text) => text.includes("[ace-origin:delegation.settled:"));

test("a settled thread stays settled when the children its settle stopped report back", async () => {
  const { f, parent, sentBefore } = await settledWithHeldResult();
  // The child's cancellation is not sent to the parent, so nothing reopens it.
  expect(f.inputs.get(parent.threadId)?.length ?? 0).toBe(sentBefore);
  expect(f.store.getThread(parent.threadId)?.settledAt).toBeDefined();
  expect(f.store.getThread(parent.threadId)?.status.state).not.toBe("working");
  expect(f.errors).toEqual([]);
});

test("a held result reaches the parent once with the person's next message, even when the wake fires before the turn starts", async () => {
  const { f, parent } = await settledWithHeldResult();
  expect(
    f.service.command("person-returns", {
      type: "thread.send",
      threadId: parent.threadId,
      input: [{ type: "text", text: "picking this up again" }],
    }).ok,
  ).toBe(true);
  // The wake timer fires while the new turn is still starting and the thread still reads settled.
  f.clock.advance(f.clock.now() + 1_050);
  await f.engine.flush();
  f.clock.advance(f.clock.now() + 1_050);
  await f.engine.flush();
  expect(f.inputs.get(parent.threadId)?.join("\n")).toContain("picking this up again");
  expect(resultsSent(f, parent.threadId)).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("unsettling a thread delivers the results held while it was settled", async () => {
  const { f, parent } = await settledWithHeldResult();
  const unsettled = organizeThread(
    f.store,
    Command.parse({
      id: "unsettle-parent",
      deviceId: "device",
      payload: { type: "thread.unsettle", threadId: parent.threadId },
    }),
    f.clock.now(),
  );
  expect(unsettled.ok).toBe(true);
  f.clock.advance(f.clock.now() + 1_050);
  await f.engine.flush();
  expect(resultsSent(f, parent.threadId)).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

const settle = (f: ReturnType<typeof setup>, thread: ThreadId, id: string) =>
  organizeThread(
    f.store,
    Command.parse({
      id,
      deviceId: "device",
      payload: { type: "thread.settle", threadId: thread },
    }),
    f.clock.now(),
  );

test("settling a thread, even again and again, never wakes a child stopped with a message still queued", async () => {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "stopped-with-queue");
  await f.engine.flush();
  await f.emit(child.childId, start);
  expect(
    f.service.command("queued-for-child", {
      type: "thread.send",
      threadId: child.childId,
      input: [{ type: "text", text: "after this" }],
      delivery: "queue",
    }).ok,
  ).toBe(true);
  expect(
    f.service.command("stop-child", {
      type: "thread.interrupt",
      threadId: child.childId,
      cascade: true,
    }).ok,
  ).toBe(true);
  await f.engine.flush();
  expect(f.engine.queue(child.childId)).toMatchObject({ paused: true, reason: "stopped" });
  await f.emit(parent.threadId, end);
  const from = f.events.length;

  for (const id of ["settle-1", "settle-2", "settle-3"]) {
    expect(settle(f, parent.threadId, id).ok).toBe(true);
    await f.engine.flush();
  }

  // The child never read as waiting to send: a parent that saw it would revive it.
  const childStatuses = f.events
    .slice(from)
    .flatMap((event) =>
      event.threadId === child.childId &&
      event.payload.type === "thread.updated" &&
      event.payload.status
        ? [event.payload.status.state]
        : [],
    );
  expect(childStatuses).not.toContain("waiting");
  expect(childStatuses).not.toContain("working");
  // The person's message is kept, held, for when they come back.
  expect(f.engine.queue(child.childId)).toMatchObject({
    paused: true,
    reason: "stopped",
    messages: [{ id: "queued-for-child" }],
  });
  expect(f.inputs.get(child.childId)?.join("\n") ?? "").not.toContain("after this");
  expect(f.store.getThread(parent.threadId)?.settledAt).toBeDefined();
  expect(f.errors).toEqual([]);
});
