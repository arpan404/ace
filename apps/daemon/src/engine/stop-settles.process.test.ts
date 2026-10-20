import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { cleanupRecovery, fixture, restart } from "./recovery-test-support.ts";
import { end, scriptFrames, start, task } from "./test-support.ts";

/*
 * A Stop always settles the thread. Background work the provider can't stop, or that died
 * without the provider saying so, never keeps a stopped thread working or waiting.
 */
afterEach(cleanupRecovery);

/** A thread whose turn ended while a background shell it started still runs. */
async function waitingOnShell(stop: { frames?: []; fail?: string }) {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      { on: "interrupt", ...stop },
    ],
    frames,
  );
  const id = await h.create();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  return { h, id };
}

const taskStatuses = (h: Awaited<ReturnType<typeof fixture>>, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).backgroundTasks).map((entry) => entry.status);

test("stopping a thread whose provider can't stop its background task still settles it", async () => {
  const { h, id } = await waitingOnShell({ fail: "OpenCode location is unavailable" });
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.map((command) => command.type)).toEqual(["send", "interrupt", "close"]);
  expect(taskStatuses(h, id)).toEqual(["unknown"]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
  const notices = Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );
  expect(notices).toEqual([]);
});

test("a stopped thread whose background task never reported ending is not resumed after a restart", async () => {
  const { h, id } = await waitingOnShell({});
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(taskStatuses(h, id)).toEqual(["running"]);

  const engine = await restart(h);
  expect(taskStatuses(h, id)).toEqual(["unknown"]);
  expect(engine.queue(id)).toMatchObject({ paused: true, reason: "stopped", messages: [] });
  expect(h.store.getThread(id)?.queue?.pendingCount).toBe(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("after a restart, a restart continuation captured behind a Stop no longer keeps the thread waiting", async () => {
  const { h, id } = await waitingOnShell({});
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  await h.engine.close();
  // What earlier builds persisted at shutdown: a "continue" held behind the Stop.
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE engine_queue SET continuation='continue', trigger='restart' WHERE thread_id=?",
      )
      .run(id),
  );

  const engine = await restart(h);
  expect(engine.queue(id)).toMatchObject({ paused: true, reason: "stopped" });
  expect(h.store.getThread(id)?.queue?.pendingCount).toBe(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
