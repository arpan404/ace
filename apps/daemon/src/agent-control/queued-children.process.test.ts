import { expect, test } from "vitest";
import { AgentControlOperation, type ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
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

test("a queued child reports its slot limit, use and queue place, shifting as the queue moves", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "running");
  await h.engine.flush();
  const first = h.delegate(parent, "first-queued");
  const second = h.delegate(parent, "second-queued");
  await h.engine.flush();

  expect(h.service.queueFacts(first.childId)).toEqual({
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(h.service.queueFacts(second.childId)).toEqual({
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 2,
  });
  expect(h.store.getThread(first.childId)?.queuedLaunch).toMatchObject({
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(launch(h, parent.threadId, first.childId).status).toMatchObject({
    state: "waiting",
    on: "queue",
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(watched(h, parent, first.childId)).toMatchObject({
    state: "queued",
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(watched(h, parent, second.childId)).toMatchObject({
    state: "queued",
    queuePosition: 2,
  });

  await h.complete(running.childId, "first done");
  await h.engine.flush();

  expect(h.service.queueFacts(first.childId)).toBeUndefined();
  expect(h.service.queueFacts(second.childId)).toEqual({
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(h.store.getThread(second.childId)?.queuedLaunch).toMatchObject({ queuePosition: 1 });
  expect(launch(h, parent.threadId, second.childId).status).toMatchObject({
    state: "waiting",
    on: "queue",
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(launch(h, parent.threadId, first.childId).status).toMatchObject({ state: "working" });
  expect(h.errors).toEqual([]);
});

test("a pump that fills the engine mid-pass still refreshes the children left behind", async () => {
  const h = setup(
    { maxConcurrent: 8 },
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { maxActiveThreads: 2 },
  );
  const parent = await h.parent();
  const first = h.delegate(parent, "first");
  await h.engine.flush();
  const second = h.delegate(parent, "second");
  const third = h.delegate(parent, "third");
  const fourth = h.delegate(parent, "fourth");
  await h.engine.flush();
  expect(
    [second, third, fourth].map((child) => h.service.queueFacts(child.childId)?.queuePosition),
  ).toEqual([1, 2, 3]);

  await h.complete(first.childId, "first done");
  await h.engine.flush();
  // The freed slot retires on the engine's idle timer; the next pump starts one child, fills
  // the engine on the next, and still refreshes the children left behind.
  h.clock.advance(h.clock.now() + 100001);
  await h.engine.flush();

  expect(h.service.journal.get(second.childId)?.phase).toBe("running");
  expect(h.service.queueFacts(second.childId)).toBeUndefined();
  expect(h.service.queueFacts(third.childId)).toEqual({
    slotLimit: 8,
    slotsInUse: 1,
    queuePosition: 1,
  });
  expect(h.service.queueFacts(fourth.childId)).toEqual({
    slotLimit: 8,
    slotsInUse: 1,
    queuePosition: 2,
  });
  expect(h.store.getThread(fourth.childId)?.queuedLaunch).toMatchObject({ queuePosition: 2 });
  expect(h.errors).toEqual([]);
});

test("starting one of fifty queued children updates each shifted child exactly once", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "running");
  const queued = Array.from({ length: 50 }, (_, index) => h.delegate(parent, `queued-${index}`));
  const [head, ...rest] = queued;
  if (!head) throw new Error("Missing queued children");
  await h.engine.flush();
  const baseline = h.events.length;

  await h.complete(running.childId, "first done");
  await h.engine.flush();

  // The head starts; every other child moves up exactly one place, with one update each.
  const updates = h.events.slice(baseline).flatMap((event) => {
    const payload = event.payload;
    return payload.type === "thread.updated" &&
      payload.queuedLaunch !== undefined &&
      payload.queuedLaunch !== null
      ? [{ child: event.threadId, facts: payload.queuedLaunch }]
      : [];
  });
  expect(h.service.journal.get(head.childId)?.phase).toBe("running");
  expect(updates).toHaveLength(rest.length);
  expect([...new Set(updates.map((update) => update.child))].toSorted()).toEqual(
    rest.map((child) => child.childId).toSorted(),
  );
  for (const [index, child] of rest.entries())
    expect(
      updates.find((update) => update.child === child.childId)?.facts,
    ).toMatchObject({ queuePosition: index + 1 });

  // Nothing more follows: no second round of queue writes, not even on the retry poll.
  for (let round = 0; round < 2; round++) {
    h.clock.advance(h.clock.now() + 2000);
    await h.engine.flush();
  }
  expect(
    h.events.slice(baseline).filter((event) => {
      const payload = event.payload;
      return (
        payload.type === "thread.updated" &&
        payload.queuedLaunch !== undefined &&
        payload.queuedLaunch !== null
      );
    }),
  ).toHaveLength(rest.length);
  expect(h.errors).toEqual([]);
});

test("cancelling a full queue writes no intermediate positions", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const running = h.delegate(parent, "running");
  const queued = Array.from({ length: 50 }, (_, index) => h.delegate(parent, `queued-${index}`));
  await h.engine.flush();
  expect(running).toBeDefined();
  const baseline = h.events.length;

  h.service.cancelDescendants(parent.threadId);
  await h.engine.flush();

  expect(
    queued.every((child) => h.service.journal.get(child.childId)?.phase === "settled"),
  ).toBe(true);
  // Every queued child settles straight to cleared: no intermediate positions on the way out.
  expect(
    h.events.slice(baseline).filter((event) => {
      const payload = event.payload;
      return (
        payload.type === "thread.updated" &&
        payload.queuedLaunch !== undefined &&
        payload.queuedLaunch !== null
      );
    }),
  ).toHaveLength(0);
  expect(h.errors).toEqual([]);
});

test("delegate_task says per child whether it started or queued, with its queue place", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const port = createAgentControlPort(h.store, h.service);
  const signal = new AbortController().signal;
  const single = (requestId: string, role: string) =>
    port.execute(
      parent,
      AgentControlOperation.parse({
        op: "delegate_task",
        requestId,
        provider: "claude",
        model: "chosen-model",
        role,
        task: `Task ${role}`,
        wait: false,
        estimatedLoad: 0,
      }),
      signal,
    );
  const started = await single("d-started", "d-started");
  await h.engine.flush();
  const queued = await single("d-queued", "d-queued");
  await h.engine.flush();

  expect(started.data).toMatchObject({ queued: false });
  expect(queued.data).toMatchObject({
    queued: true,
    slotLimit: 1,
    slotsInUse: 1,
    queuePosition: 1,
  });

  const batch = await port.execute(
    parent,
    AgentControlOperation.parse({
      op: "delegate_task",
      tasks: [0, 1].map((index) => ({
        requestId: `d-batch-${index}`,
        provider: "claude",
        model: "chosen-model",
        role: `d-batch-${index}`,
        task: `Batch ${index}`,
      })),
    }),
    signal,
  );
  await h.engine.flush();
  expect(batch.data).toMatchObject({
    launches: [
      { queued: true, queuePosition: 2 },
      { queued: true, queuePosition: 3 },
    ],
  });
  expect(h.errors).toEqual([]);
});
