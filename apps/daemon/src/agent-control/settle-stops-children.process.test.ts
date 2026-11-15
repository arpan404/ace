import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
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

test("a settled thread stays settled when the children its settle stopped report back", async () => {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "asks-a-question");
  await f.engine.flush();
  await f.emit(child.childId, start, question);
  expect(f.store.getThread(parent.threadId)?.status.state).not.toBe("working");
  const sentBefore = f.inputs.get(parent.threadId)?.length ?? 0;

  const settled = organizeThread(
    f.store,
    Command.parse({
      id: "settle-busy-parent",
      deviceId: "device",
      payload: { type: "thread.settle", threadId: parent.threadId },
    }),
    f.clock.now(),
  );
  expect(settled.ok).toBe(true);
  await f.engine.flush();
  f.clock.advance(f.clock.now() + 5_000);
  await f.engine.flush();

  // The child's cancellation is not sent to the parent, so nothing reopens it.
  expect(f.inputs.get(parent.threadId)?.length ?? 0).toBe(sentBefore);
  expect(f.store.getThread(parent.threadId)?.settledAt).toBeDefined();
  expect(f.store.getThread(parent.threadId)?.status.state).not.toBe("working");
  expect(f.errors).toEqual([]);

  // The person comes back: the held result reaches the parent with their message.
  expect(
    f.service.command("person-returns", {
      type: "thread.send",
      threadId: parent.threadId,
      input: [{ type: "text", text: "picking this up again" }],
    }).ok,
  ).toBe(true);
  await f.engine.flush();
  f.clock.advance(f.clock.now() + 1_050);
  await f.engine.flush();
  const sent = f.inputs.get(parent.threadId)?.join("\n") ?? "";
  expect(sent).toContain("picking this up again");
  expect(sent).toContain("[ace-origin:delegation.settled:");
});
