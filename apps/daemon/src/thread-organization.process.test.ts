import { afterEach, expect, test } from "vitest";
import { Agent, BackgroundTask, Command, type CommandPayload } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
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
  const second = await f.connect();
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
  await f.second.next();
  await f.command({ type: "thread.snooze", threadId: f.thread.id, until: 9000 });
  await f.second.next();
  expect(f.store.getThread(f.thread.id)).toMatchObject({
    title: "Renamed",
    pinned: true,
    unread: true,
    readAt: 1000,
    snoozedUntil: 9000,
  });
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

test("manual settlement refuses human waits and deletion refuses live background work", async () => {
  const f = await setup();
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  expect(await f.command({ type: "thread.settle", threadId: f.thread.id })).toMatchObject({
    ok: false,
    error: "thread_not_done",
  });
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "waiting", on: "background_task" } },
  ]);
  expect(await f.command({ type: "thread.delete", threadId: f.thread.id })).toMatchObject({
    ok: false,
    error: "thread_busy",
  });
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
});

test("a merged PR cannot settle a tree that is still waiting on a human", async () => {
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
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "thread.client.updated",
        changes: { details: { linkedPr: { number: 42, state: "merged" } } },
      },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ],
    now,
  );
  now += 2 * 86_400_000;
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }], now);
  await organizer.sweep();
  expect(f.store.getThread(f.thread.id)?.settledReason).toBe("pr_merged");
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
