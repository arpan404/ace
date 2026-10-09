import { afterEach, expect, test } from "vitest";
import {
  Agent,
  BackgroundTask,
  Command,
  DeviceId,
  Item,
  ItemId,
  type CommandPayload,
} from "@ace/protocol";
import { token, fixture } from "./socket-test-support.ts";
import { ThreadOrganizer } from "./thread-organizer.ts";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function setup(now: () => number = () => 1000) {
  const f = await fixture({ now });
  close = f.close;
  const first = await f.connect();
  await first.next();
  const second = await f.open();
  second.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("second"), token });
  await second.next();
  let seq = 0;
  const command = async (payload: CommandPayload, id = `organize-${++seq}`) => {
    first.send({ type: "command", command: Command.parse({ id, deviceId: "device", payload }) });
    return first.next();
  };
  return { ...f, first, second, command };
}

test("two devices receive the same rename, pin, unread and snooze projections", async () => {
  const f = await setup();
  f.second.send({ type: "subscribe", subscriptionId: "sidebar", scope: { kind: "threads" } });
  await f.second.next();
  await f.command({ type: "thread.rename", threadId: f.thread.id, title: "Renamed" });
  expect(await f.second.next()).toMatchObject({
    type: "events",
    events: [{ payload: { title: "Renamed" } }],
  });
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: true });
  expect(await f.second.next()).toMatchObject({
    type: "events",
    events: [{ payload: { changes: { pinned: true } } }],
  });
  await f.command({ type: "thread.read", threadId: f.thread.id, unread: true });
  expect(await f.second.next()).toMatchObject({
    type: "events",
    events: [{ payload: { changes: { unread: true, readAt: 1000 } } }],
  });
  await f.command({ type: "thread.snooze", threadId: f.thread.id, until: 9000 });
  expect(await f.second.next()).toMatchObject({
    type: "events",
    events: [{ payload: { changes: { snoozedUntil: 9000 } } }],
  });
  const expected = {
    title: "Renamed",
    pinned: true,
    unread: true,
    readAt: 1000,
    snoozedUntil: 9000,
  };
  f.first.send({
    type: "subscribe",
    subscriptionId: "thread",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  expect(await f.first.next()).toMatchObject({ type: "snapshot", view: { thread: expected } });
  f.second.send({
    type: "subscribe",
    subscriptionId: "updated-sidebar",
    scope: { kind: "threads" },
  });
  expect(await f.second.next()).toMatchObject({
    type: "snapshot",
    view: { threads: { [f.thread.id]: expected } },
  });
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    title: "Renamed",
    pinned: true,
    unread: true,
    readAt: 1000,
    snoozedUntil: 9000,
  });
});

test("a pinned thread's place reaches other devices, survives a re-pin and goes with the pin", async () => {
  let now = 1000;
  const f = await setup(() => now);
  f.second.send({ type: "subscribe", subscriptionId: "sidebar", scope: { kind: "threads" } });
  await f.second.next();
  // A pin that names no place leads: the daemon's clock orders it above earlier pins.
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: true });
  expect(await f.second.next()).toMatchObject({
    events: [{ payload: { changes: { pinned: true, pinOrder: 1000 } } }],
  });
  // Dragged between two others: the client names the place.
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: true, order: 512.5 });
  expect(await f.second.next()).toMatchObject({
    events: [{ payload: { changes: { pinned: true, pinOrder: 512.5 } } }],
  });
  // Pinning again from another device's menu keeps the place it was dragged to.
  now = 5000;
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: true });
  expect(f.store.getThread(f.thread.id)).toMatchObject({ pinned: true, pinOrder: 512.5 });
  await f.second.next();
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: false });
  expect(await f.second.next()).toMatchObject({
    events: [{ payload: { changes: { pinned: false, pinOrder: null } } }],
  });
  expect(f.store.getThread(f.thread.id)?.pinOrder).toBeUndefined();
  // Pinned anew, it leads again rather than returning to its old place.
  await f.command({ type: "thread.pin", threadId: f.thread.id, pinned: true });
  expect(f.store.getThread(f.thread.id)).toMatchObject({ pinned: true, pinOrder: 5000 });
});

test("archive is immediate and unarchive survives receipt retries without losing the thread", async () => {
  const f = await setup();
  await f.command({ type: "thread.archive", threadId: f.thread.id }, "archive");
  expect(f.store.getThread(f.thread.id)?.archivedAt).toBe(1000);
  await f.command({ type: "thread.unarchive", threadId: f.thread.id }, "undo");
  const head = f.store.headSeq();
  await f.command({ type: "thread.unarchive", threadId: f.thread.id }, "undo");
  expect(f.store.getThread(f.thread.id)?.archivedAt).toBeUndefined();
  expect(f.store.headSeq()).toBe(head);
});

test("deletion hides a quiescent thread while preserving replay coverage", async () => {
  const f = await setup();
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
  const before = f.store.headSeq();
  expect(await f.command({ type: "thread.delete", threadId: f.thread.id })).toMatchObject({
    ok: true,
  });
  expect(f.store.getThread(f.thread.id)?.deletedAt).toBe(1000);
  f.second.send({ type: "subscribe", subscriptionId: "list", scope: { kind: "threads" } });
  const snapshot = await f.second.next();
  expect(snapshot).toMatchObject({ type: "snapshot", view: { threads: {} } });
  expect(f.store.readEvents({ afterSeq: before, limit: 10 }).at(-1)?.payload).toMatchObject({
    type: "thread.client.updated",
    changes: { deletedAt: 1000 },
  });
});

test("inactivity settles only done trees at the daemon deadline and unsettle starts a new deadline", async () => {
  let now = 1000;
  const f = await setup(() => now);
  const organizer = new ThreadOrganizer(
    f.store,
    undefined,
    () => now,
    () => () => {},
  );
  close = async () => {
    await organizer.close();
    await f.close();
  };
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }], now);
  await organizer.sweep();
  now += 86_400_000 - 1;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  now++;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    settledAt: now,
    settledReason: "inactivity",
  });
  await f.command({ type: "thread.unsettle", threadId: f.thread.id });
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  expect(f.store.getThread(f.thread.id)?.autoSettleAt).toBe(now + 86_400_000);
  now += 86_400_000 - 1;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  now++;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    settledAt: now,
    settledReason: "inactivity",
  });
});

test("snooze expires on the daemon clock and a renewed working tree immediately leaves settled", async () => {
  let now = 1000;
  const f = await setup(() => now);
  const organizer = new ThreadOrganizer(
    f.store,
    undefined,
    () => now,
    () => () => {},
  );
  close = async () => {
    await organizer.close();
    await f.close();
  };
  await f.command({ type: "thread.snooze", threadId: f.thread.id, until: 2000 });
  await organizer.sweep();
  now = 1999;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.snoozedUntil).toBe(2000);
  now = 2000;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.snoozedUntil).toBeUndefined();
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }], now);
  await f.command({ type: "thread.settle", threadId: f.thread.id });
  expect(f.store.getThread(f.thread.id)?.settledAt).toBe(now);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.updated", status: { state: "working", agents: 1 } }],
    now,
  );
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
});

test("sidebar metadata counts known subagents and live tasks once across duplicate provider facts", async () => {
  const f = await setup();
  const child = Agent.parse({
    id: "child",
    threadId: f.thread.id,
    parentId: "root",
    origin: "provider_subagent",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 1,
  });
  const task = BackgroundTask.parse({
    id: "task",
    agentId: child.id,
    kind: "shell",
    title: "Build",
    status: "running",
    stoppable: true,
    startedAt: 1,
  });
  f.store.appendEvents(f.thread.id, [
    { type: "agent.created", agent: child },
    { type: "agent.created", agent: child },
    { type: "background_task.started", task },
    { type: "background_task.started", task },
  ]);
  f.second.send({ type: "subscribe", subscriptionId: "sidebar", scope: { kind: "threads" } });
  const sidebar = await f.second.next();
  expect(sidebar).toMatchObject({
    type: "snapshot",
    view: {
      threads: {
        [f.thread.id]: { live: { provider: "codex", subagentCount: 1, backgroundTaskCount: 1 } },
      },
    },
  });
  expect(f.store.snapshotThread(f.thread.id).thread.live).toMatchObject({
    subagentCount: 1,
    backgroundTaskCount: 1,
  });
  f.store.appendEvents(f.thread.id, [
    { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 2 },
    { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 2 },
  ]);
  expect(f.store.snapshotThread(f.thread.id).thread.live).toMatchObject({
    subagentCount: 1,
    backgroundTaskCount: 0,
  });
});

test("sidebar metadata says the root agent is running tests, from its step's stored command", async () => {
  const f = await setup();
  const root = Agent.parse({
    id: "root-tests",
    threadId: f.thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 1,
  });
  const step = (id: string, command: string) =>
    Item.parse({
      id,
      agentId: root.id,
      createdAt: 2,
      complete: false,
      type: "tool_call",
      call: {
        id,
        agentId: root.id,
        kind: "shell",
        title: command,
        status: "running",
        detail: { kind: "shell", command },
        startedAt: 2,
        raw: [],
      },
    });
  const working = (itemId: string) => ({
    type: "agent.status" as const,
    agentId: root.id,
    status: { state: "working" as const, activity: "tool" as const, itemId: ItemId.parse(itemId) },
  });
  f.store.appendEvents(f.thread.id, [
    { type: "agent.created", agent: root },
    { type: "item.created", item: step("vitest", "bun run test src/replay.test.ts") },
    working("vitest"),
  ]);
  expect(f.store.getThread(f.thread.id)?.live?.step).toBe("tests");
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: step("build", "bun run build") },
    working("build"),
  ]);
  expect(f.store.getThread(f.thread.id)?.live?.step).toBeUndefined();
});

test("completed old turns with retained queue holds cannot be settled from another device", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "thread.updated", status: { state: "done" } },
      {
        type: "queue.updated",
        paused: true,
        reason: "not_sent",
        resumeAt: null,
        revision: 1,
        pendingCount: 1,
      },
    ],
    1000,
  );
  expect(await f.command({ type: "thread.settle", threadId: f.thread.id })).toMatchObject({
    type: "commandResult",
    ok: false,
    error: "thread_not_done",
  });
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "queue.updated",
        paused: false,
        reason: null,
        resumeAt: null,
        revision: 2,
        pendingCount: 0,
      },
    ],
    1001,
  );
  expect(await f.command({ type: "thread.settle", threadId: f.thread.id })).toMatchObject({
    type: "commandResult",
    ok: true,
  });
  expect(f.store.getThread(f.thread.id)?.settledAt).toBe(1000);
});
