import { expect, test } from "vitest";
import { z } from "zod";
import { createAgentControlPort } from "@ace/daemon";
import { AgentControlOperation, ThreadId } from "@ace/protocol";
import { setup, wakes } from "./test-support.ts";

const signal = () => new AbortController().signal;

test("a root keeps delegating after 70 children have finished", async () => {
  // A lowered journal bound proves settled children never count toward it.
  const h = setup({}, undefined, false, undefined, false, undefined, 2);
  const parent = await h.parent();
  for (let index = 0; index < 70; index++) {
    const child = h.delegate(parent, `finished-${index}`);
    await h.engine.flush();
    await h.complete(child.childId, `result ${index}`);
  }
  const next = h.delegate(parent, "after-seventy");
  await h.engine.flush();
  expect(h.store.getThread(next.childId)?.status.state).toBe("working");
  expect(h.errors).toEqual([]);
});

test("results from more than 64 children all reach the parent", async () => {
  const h = setup();
  const parent = await h.parent();
  const children: ThreadId[] = [];
  for (let index = 0; index < 70; index++) {
    const child = h.delegate(parent, `settled-${index}`);
    children.push(child.childId);
    await h.engine.flush();
    await h.complete(child.childId, `result-${index}-done`);
  }
  for (let tick = 0; tick < 4; tick++) {
    h.clock.advance(1050);
    await h.engine.flush();
  }
  const delivered = h.inputs.get(parent.threadId)?.join("\n") ?? "";
  for (let index = 0; index < 70; index++) expect(delivered).toContain(`result-${index}-done`);
  expect(wakes(h.events, parent.threadId).length).toBeGreaterThanOrEqual(2);
  expect(h.errors).toEqual([]);
});

test("after Stop, the parent can delegate again in its next turn and earlier results still arrive", async () => {
  const h = setup();
  const parent = await h.parent();
  const early = h.delegate(parent, "early");
  const running = h.delegate(parent, "running");
  await h.engine.flush();
  await h.complete(early.childId, "early result kept");
  expect(
    h.service.command("stop-root", {
      type: "thread.interrupt",
      threadId: parent.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  h.clock.advance(1050);
  await h.engine.flush();
  // Stop cancels the running child and does not wake the stopped parent.
  expect(await h.service.wait(parent, running.childId, signal())).toMatchObject({
    outcome: "cancelled",
  });
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  expect(
    h.service.command("next-turn", {
      type: "thread.send",
      threadId: parent.threadId,
      trigger: "user",
      input: [{ type: "text", text: "Carry on" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const again = h.delegate(parent, "after-stop");
  await h.engine.flush();
  expect(h.store.getThread(again.childId)?.status.state).toBe("working");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain("early result kept");
  expect(h.errors).toEqual([]);
});

test("with a limit of four, a fifth child queues and starts when one finishes", async () => {
  const h = setup({ maxConcurrent: 4 });
  const parent = await h.parent();
  const children = Array.from({ length: 5 }, (_, index) => h.delegate(parent, `child-${index}`));
  await h.engine.flush();
  const [first] = children;
  const fifth = children.at(-1);
  if (!first || !fifth) throw new Error("Missing children");
  for (const child of children.slice(0, 4))
    expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  expect(h.contexts.has(fifth.childId)).toBe(false);
  // The parent shows the queued child as blocked on the launch queue, so it can never read done meanwhile.
  const shown = Object.values(h.store.snapshotThread(parent.threadId).agents).find(
    (agent) => agent.childThreadId === fifth.childId,
  );
  expect(shown?.status).toMatchObject({ state: "blocked", on: "queue" });
  expect(h.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  h.restartOwner();
  await h.engine.flush();
  expect(h.contexts.has(fifth.childId)).toBe(false);
  await h.complete(first.childId, "first done");
  await h.engine.flush();
  expect(h.store.getThread(fifth.childId)?.status.state).toBe("working");
  expect(h.inputs.get(fifth.childId)?.join("\n")).toContain("Implement safely");
  expect(h.errors).toEqual([]);
});

test("a person can message a finished child while the parent has 4 working children", async () => {
  const h = setup();
  const parent = await h.parent();
  const finished = h.delegate(parent, "finished");
  await h.engine.flush();
  await h.complete(finished.childId, "first pass");
  for (let index = 0; index < 4; index++) h.delegate(parent, `busy-${index}`);
  await h.engine.flush();
  expect(
    h.service.command("person-follow-up", {
      type: "thread.send",
      threadId: finished.childId,
      trigger: "user",
      input: [{ type: "text", text: "One more thing" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(finished.childId)?.status.state).toBe("working");
  expect(h.inputs.get(finished.childId)?.at(-1)).toBe("One more thing");
});

test("with a limit of four, a batch of eight tasks creates every child: four start and the rest wait their turn", async () => {
  const h = setup({ maxConcurrent: 4 });
  const parent = await h.parent();
  const port = createAgentControlPort(h.store, h.service);
  const result = await port.execute(
    parent,
    AgentControlOperation.parse({
      op: "delegate_task",
      tasks: Array.from({ length: 8 }, (_, index) => ({
        requestId: `batch-${index}`,
        provider: "claude",
        model: "chosen-model",
        role: `batch-task-${index}`,
        task: `Batch task ${index}`,
      })),
    }),
    signal(),
  );
  expect(result.ok).toBe(true);
  const { threadIds } = z.object({ threadIds: z.array(ThreadId) }).parse(result.data);
  expect(threadIds).toHaveLength(8);
  await h.engine.flush();
  const started = threadIds.filter((id) => h.contexts.has(id));
  expect(started).toHaveLength(4);
  for (const id of started) await h.complete(id, "done");
  await h.engine.flush();
  for (const id of threadIds) expect(h.contexts.has(id)).toBe(true);
  expect(h.errors).toEqual([]);
});

test("a queued child whose start meets a full disk stays queued, keeps its parent open, and starts once space is back", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const first = h.delegate(parent, "first");
  const second = h.delegate(parent, "second");
  await h.engine.flush();
  // The disk boundary: the store's connection may not grow the file, and the slack left in it
  // is filled, so the next write fails with SQLITE_FULL as on a full volume.
  const disk = h.store.atomic((db) => db);
  disk.exec("CREATE TABLE IF NOT EXISTS filler (x BLOB)");
  const fill = () => {
    disk.exec(
      `PRAGMA max_page_count=${Number(disk.prepare("PRAGMA page_count").get()?.page_count)}`,
    );
    try {
      for (;;) disk.prepare("INSERT INTO filler VALUES (randomblob(1024))").run();
    } catch {
      /* Full: what a full disk leaves. */
    }
  };
  // No pump runs while admission is closed, so the slot is freed before the disk fills.
  h.closeAdmission();
  await h.complete(first.childId, "first done");
  fill();
  h.openAdmission();
  // The retry timer drains the queue. Nothing awaits the engine here: its own writes wait for
  // space, as running turns do while the disk is full.
  h.clock.advance(1050);

  expect(h.contexts.has(second.childId)).toBe(false);
  const shown = () =>
    Object.values(h.store.snapshotThread(parent.threadId).agents).find(
      (agent) => agent.childThreadId === second.childId,
    );
  expect(shown()?.status).toMatchObject({ on: "queue" });
  expect(h.store.getThread(parent.threadId)?.status.state).not.toBe("done");

  disk.exec("PRAGMA max_page_count=1073741823");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.store.getThread(second.childId)?.status.state).toBe("working");
  expect(h.inputs.get(second.childId)?.join("\n")).toContain("Implement safely");
});

test("a queued child says it waits for disk space while the disk is full, and its place again once space is back", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  h.delegate(parent, "running");
  const queued = h.delegate(parent, "queued");
  await h.engine.flush();
  const row = () =>
    h.service.monitor.snapshot(parent).children.find((c) => c.id === queued.childId);
  // The parent's subagent row reads the child's status off its launch item.
  const shown = () => {
    const launch = Object.values(h.store.snapshotThread(parent.threadId).items).find(
      (item) => item.type === "delegation.started" && item.childThreadId === queued.childId,
    );
    return launch?.type === "delegation.started" ? launch.status : undefined;
  };

  h.setStorageFull(true);
  // What agents_status reads, what the parent shows and what the child's own page reads.
  expect(row()).toMatchObject({
    state: "queued",
    step: "Waiting for disk space",
    waitingFor: "storage",
  });
  expect(shown()).toMatchObject({ on: "queue", waitingFor: "storage" });
  expect(h.store.getThread(queued.childId)?.queuedLaunch).toMatchObject({ waitingFor: "storage" });

  h.setStorageFull(false);
  expect(row()?.step).toBe("queued: position 1, 1 of 1 run slots in use");
  expect(row()?.waitingFor).toBeUndefined();
  expect(shown()).not.toHaveProperty("waitingFor");
  expect(h.store.getThread(queued.childId)?.queuedLaunch).not.toHaveProperty("waitingFor");
});
