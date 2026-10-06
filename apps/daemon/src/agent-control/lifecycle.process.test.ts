import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { setup, wakes } from "./test-support.ts";

test("ordinary engine sends reopen child accounting, wake again and participate in cancellation", async () => {
  const h = setup({ maxConcurrent: 1 }, undefined, false, undefined, true);
  const parent = await h.parent();
  const child = h.delegate(parent, "child");
  await h.engine.flush();
  await h.complete(child.childId, "first");
  h.clock.advance(1050);
  await h.engine.flush();
  const command = Command.parse({
    id: randomUUID(),
    deviceId: "ui",
    payload: {
      type: "thread.send",
      threadId: child.childId,
      input: [{ type: "text", text: "Continue from UI" }],
      delivery: "queue",
    },
  });
  const send = () =>
    h.store.recordCommand(command.id, command.deviceId, () =>
      h.engine.handler.handle(command, commandContext(h.store)),
    );
  expect(send().ok).toBe(true);
  expect(() => h.delegate(parent, "over-capacity")).toThrow(/concurrency/);
  await h.engine.flush();
  await h.complete(child.childId, "second");
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(2);
  expect(send().ok).toBe(true);
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
  const again = Command.parse({ ...command, id: randomUUID() });
  expect(h.engine.handler.handle(again, commandContext(h.store)).ok).toBe(true);
  await h.engine.flush();
  h.service.cancelDescendants(parent.threadId);
  await h.engine.flush();
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
});

test("a reopened subtree receives a fresh cascading interruption while unrelated work survives", async () => {
  const h = setup();
  const parent = await h.parent();
  const a = h.delegate(parent, "a"),
    sibling = h.delegate(parent, "sibling");
  await h.engine.flush();
  const b = h.delegate(h.caller(a.childId), "b");
  await h.engine.flush();
  const interrupt = (id: string) =>
    h.service.command(id, {
      type: "thread.interrupt",
      threadId: a.childId,
      cascade: true,
    });
  expect(interrupt("first").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(b.childId)?.status.state).toBe("done");
  h.restartOwner();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, a.childId)).toHaveLength(0);
  expect(h.service.message(parent, "resume-a", a.childId, "again", "queue").ok).toBe(true);
  expect(h.service.message(parent, "resume-b", b.childId, "again", "queue").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(b.childId)?.status).toEqual({ state: "waiting", on: "queue" });
  for (const threadId of [a.childId, b.childId])
    expect(
      h.service.command(`release-${threadId}`, {
        type: "queue.resume",
        threadId,
        expectedRevision: h.engine.queue(threadId).revision,
      }).ok,
    ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(b.childId)?.status.state).toBe("working");
  expect(interrupt("first").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(b.childId)?.status.state).toBe("working");
  expect(interrupt("second").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(b.childId)?.status.state).toBe("done");
  expect(await h.service.wait(parent, b.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  expect(h.store.getThread(sibling.childId)?.status.state).toBe("working");
});

test("a prepared child cannot launch after admission closes or the service shuts down", async () => {
  const h = setup();
  const parent = await h.parent();
  const record = h.service.prepare(parent, {
    requestId: "prepared",
    provider: "claude",
    role: "worker",
    task: "work",
    wait: false,
    estimatedLoad: 0,
  });
  h.closeAdmission();
  expect(() => h.service.launch(record, "work")).toThrow(/Admission closed/);
  await h.engine.flush();
  expect(h.contexts.has(record.childId)).toBe(false);
  h.openAdmission();
  h.service.close();
  expect(() => h.service.launch(record, "work")).toThrow(/Admission closed/);
  expect(
    h.engine.handler.handle(
      Command.parse({
        id: "direct-launch",
        deviceId: "ui",
        payload: {
          type: "thread.send",
          threadId: record.childId,
          input: [{ type: "text", text: "work" }],
          delivery: "queue",
        },
      }),
      commandContext(h.store),
    ).ok,
  ).toBe(false);
  await h.engine.flush();
  expect(h.contexts.has(record.childId)).toBe(false);
});

test("resuming a stopped root keeps cancelled child results readable without waking the new turn", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "old-child");
  await h.engine.flush();
  expect(
    h.service.command("stop-root", {
      type: "thread.interrupt",
      threadId: parent.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  // Accept the new input before the old child's interrupt result arrives.
  expect(
    h.service.command("resume-root", {
      type: "thread.send",
      threadId: parent.threadId,
      trigger: "user",
      input: [{ type: "text", text: "New work" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  expect(() => h.delegate(h.caller(child.childId), "stopped-child-work")).toThrow("cancelled");
  h.restartOwner();
  const fresh = h.delegate(parent, "fresh-child");
  await h.engine.flush();
  expect(h.store.getThread(fresh.childId)?.status.state).toBe("working");
});

test("automatic and rejected resume inputs cannot restore a stopped root's delegation authority", async () => {
  const h = setup();
  const parent = await h.parent();
  expect(
    h.service.command("stop-root", {
      type: "thread.interrupt",
      threadId: parent.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  for (const trigger of ["subagent_result", "background_completion", "restart"] as const)
    expect(
      h.service.command(`auto-${trigger}`, {
        type: "thread.send",
        threadId: parent.threadId,
        trigger,
        input: [{ type: "text", text: "Automatic input" }],
      }),
    ).toMatchObject({ ok: false, error: "cancelled" });
  expect(
    h.service.command("stale-resume", {
      type: "queue.resume",
      threadId: parent.threadId,
      expectedRevision: h.engine.queue(parent.threadId).revision + 1,
    }).ok,
  ).toBe(false);
  expect(() => h.delegate(parent, "still-stopped")).toThrow("cancelled");
  h.restartOwner();
  expect(() => h.delegate(parent, "stopped-after-restart")).toThrow("cancelled");
  expect(
    h.service.command("resume-root", {
      type: "queue.resume",
      threadId: parent.threadId,
      expectedRevision: h.engine.queue(parent.threadId).revision,
    }).ok,
  ).toBe(true);
  expect(h.delegate(parent, "restored").parentId).toBe(parent.threadId);
});

test("upgrading a stopped tree preserves suppression of late cancelled results after root resume", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "old-child");
  await h.engine.flush();
  expect(
    h.service.command("stop-root", {
      type: "thread.interrupt",
      threadId: parent.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  // Replay the persisted journal layout from before the wake-suppression migration.
  h.store.atomic((db) => db.exec("ALTER TABLE delegated_threads DROP COLUMN wake_suppressed"));
  h.restartOwner();
  expect(
    h.service.command("resume-root", {
      type: "thread.send",
      threadId: parent.threadId,
      input: [{ type: "text", text: "New work" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  const fresh = h.delegate(parent, "fresh-child");
  await h.engine.flush();
  expect(h.store.getThread(fresh.childId)?.status.state).toBe("working");
});
