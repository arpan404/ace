import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { end, task } from "../engine/test-support.ts";
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
  expect(f.store.getThread(child.childId)?.status).toEqual({
    state: "waiting",
    on: "background_task",
  });
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
