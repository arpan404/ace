import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { Store, createDevThread } from "@ace/daemon";
import { controlAdmissionError } from "./failure.ts";
import { LaunchQueue, drainLaunches, startOrQueue, type QueuedLaunch } from "./launch-queue.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** A real store with a parent's queue and three children waiting in it, oldest first. */
async function queued() {
  const home = await mkdtemp(join(tmpdir(), "ace-launch-queue-"));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(async () => {
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const workspace = store.createWorkspace(home, "project");
  const children = ["a", "b", "c"].map((title) => createDevThread(store, workspace, title).id);
  const queue = new LaunchQueue(store);
  for (const childId of children) queue.add({ childId, parentId: "parent", text: "task" });
  return { store, queue, children };
}
const stillStarting = () => {
  throw controlAdmissionError("engine_starting");
};

test("a child launched while the engine is still starting waits in the queue instead of being refused", async () => {
  const { queue, children } = await queued();
  const [first] = children;
  if (!first) throw new Error("Missing child");
  const fresh = { childId: first, parentId: "other-parent", text: "task" };
  queue.take(first);
  expect(startOrQueue(queue, fresh, 1, stillStarting)).toBe("queued");
  expect(queue.has(first)).toBe(true);
});

test("a drain while the engine is still starting leaves every child queued, and none failed", async () => {
  const { store, queue, children } = await queued();
  const failed: ThreadId[] = [];
  expect(
    drainLaunches(store, queue, "parent", 2, stillStarting, (child) => failed.push(child)),
  ).toBe("later");
  expect(failed).toEqual([]);
  for (const child of children) expect(queue.has(child)).toBe(true);

  // Once it has started, the same drain starts the oldest children into the free slots.
  const started: QueuedLaunch[] = [];
  expect(
    drainLaunches(
      store,
      queue,
      "parent",
      2,
      (launch) => {
        started.push(launch);
        return "started";
      },
      (child) => failed.push(child),
    ),
  ).toBe("drained");
  expect(started.map((launch) => launch.childId)).toEqual(children.slice(0, 2));
  const [, , last] = children;
  if (!last) throw new Error("Missing child");
  expect(queue.has(last)).toBe(true);
  expect(failed).toEqual([]);
});
