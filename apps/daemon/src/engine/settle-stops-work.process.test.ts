import { afterEach, expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import type { Store } from "@ace/daemon";
import { organizeThread } from "../thread-organization.ts";
import { cleanupRecovery, fixture } from "./recovery-test-support.ts";
import { end, scriptFrames, start, task } from "./test-support.ts";

/*
 * Settling says the person is done with a thread, so nothing it started keeps running: its
 * provider session and every background task it owns stop. A stop that fails is for the log,
 * never for the person.
 */
afterEach(cleanupRecovery);

function settle(store: Store, id: ThreadId, at: number) {
  return organizeThread(
    store,
    Command.parse({
      id: `settle-${at}`,
      deviceId: "device",
      payload: { type: "thread.settle", threadId: id },
    }),
    at,
  );
}

/** A thread whose turn ended while a background shell it started still runs. */
async function waitingOnShell() {
  const logged: [ThreadId, unknown][] = [];
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames, {
    onSettleCleanupFailure: (thread, error) => logged.push([thread, error]),
  });
  const id = await h.create();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  return { h, id, logged };
}

const taskStatuses = (h: Awaited<ReturnType<typeof fixture>>, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).backgroundTasks).map((entry) => entry.status);

const errorNotices = (h: Awaited<ReturnType<typeof fixture>>, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );

test("settling a thread with a background shell still running stops its session and the shell", async () => {
  const { h, id } = await waitingOnShell();
  expect(settle(h.store, id, h.clock.now()).ok).toBe(true);
  await h.engine.flush();
  expect(h.engine.hasSession(id)).toBe(false);
  expect(taskStatuses(h, id)).not.toContain("running");
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.engine.liveWork(id)).toEqual({ agentsRunning: 0, operationsRunning: 0 });
});

test("a settled thread whose session won't close logs why and shows the person nothing", async () => {
  const { h, id, logged } = await waitingOnShell();
  // The provider CLI refuses to exit.
  for (const session of h.adapter.sessions)
    Object.assign(session, { close: () => Promise.reject(new Error("provider did not exit")) });
  expect(settle(h.store, id, h.clock.now()).ok).toBe(true);
  await h.engine.flush();
  expect(logged.map(([thread, error]) => [thread, String(error)])).toEqual([
    [id, "Error: provider did not exit"],
  ]);
  expect(errorNotices(h, id)).toEqual([]);
  expect(h.store.getThread(id)?.settledAt).toBeDefined();
});
