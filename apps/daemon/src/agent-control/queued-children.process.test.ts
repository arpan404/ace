import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";

function launch(h: ReturnType<typeof setup>, parent: ThreadId, child: ThreadId) {
  const item = h.store
    .readItemPage(parent, h.store.headSeq() + 1, 50)
    .items.find((entry) => entry.type === "delegation.started" && entry.childThreadId === child);
  if (item?.type !== "delegation.started") throw new Error("Missing launch");
  return item;
}

function watched(h: ReturnType<typeof setup>, parent: ReturnType<typeof h.caller>, id: ThreadId) {
  return h.service.monitor.snapshot(parent).children.find((child) => child.id === id);
}

test("a child queued past the parent's slots reads as queued in its parent's card and its own status", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "running");
  await h.engine.flush();
  const queued = h.delegate(parent, "queued");
  await h.engine.flush();

  expect(watched(h, parent, running.childId)?.state).toBe("working");
  expect(watched(h, parent, queued.childId)).toMatchObject({ state: "queued" });
  expect(h.service.monitor.snapshot(parent).counts).toMatchObject({ working: 1, queued: 1 });
  expect(launch(h, parent.threadId, queued.childId)).toMatchObject({
    phase: "created",
    status: { state: "waiting", on: "queue" },
  });
  // The queued child still keeps its parent open.
  expect(h.store.getThread(parent.threadId)?.status.state).not.toBe("done");

  await h.complete(running.childId, "first done");
  await h.engine.flush();
  expect(watched(h, parent, queued.childId)?.state).toBe("working");
  expect(launch(h, parent.threadId, queued.childId).phase).toBe("running");
  expect(h.store.getThread(queued.childId)?.queuedLaunch).toBeUndefined();
});

test("a queued child's thread shows its task until it starts", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "first");
  await h.engine.flush();
  const queued = h.delegate(parent, "second");
  await h.engine.flush();

  expect(h.store.getThread(queued.childId)?.queuedLaunch?.text).toContain("Implement safely");
  expect(h.store.getThread(running.childId)?.queuedLaunch).toBeUndefined();
  const view = h.store.snapshotThread(queued.childId);
  expect(view.thread?.queuedLaunch?.text).toContain("Implement safely");
});

test("a delegated child names its parent whether it is queued or running", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "named-running");
  await h.engine.flush();
  const queued = h.delegate(parent, "named-queued");
  await h.engine.flush();

  expect(h.store.getThread(running.childId)?.delegatedBy).toBe(parent.threadId);
  expect(h.store.getThread(queued.childId)?.delegatedBy).toBe(parent.threadId);
  expect(h.store.snapshotThread(queued.childId).thread?.delegatedBy).toBe(parent.threadId);
});

test("a queued child stopped before it starts no longer reads as queued", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  h.delegate(parent, "holder");
  await h.engine.flush();
  const queued = h.delegate(parent, "stopped-in-queue");
  await h.engine.flush();
  h.service.cancelDescendants(parent.threadId);
  await h.engine.flush();

  expect(h.store.getThread(queued.childId)?.queuedLaunch).toBeUndefined();
  expect(watched(h, parent, queued.childId)?.state).not.toBe("queued");
});
