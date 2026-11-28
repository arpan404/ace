import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ActivityPush, LiveActivityTarget } from "@ace/notify";
import {
  AgentId,
  BackgroundTaskId,
  DeviceId,
  NotificationPreferences,
  type ThreadStatus,
} from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { createActivityDelivery } from "./notification-activity-delivery.ts";
import { Store } from "./store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const target: LiveActivityTarget = {
  token: "b2".repeat(32),
  environment: "sandbox",
  kind: "liveactivity",
  frequentUpdates: true,
  slot: 0,
  devices: [DeviceId.parse("phone")],
};

/** One phone's activity on a temp store. Reads happen only when the test calls `read`. */
function lane() {
  const home = mkdtempSync(join(tmpdir(), "ace-activity-"));
  const store = new Store(join(home, "events.sqlite"));
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo")).id;
  let wall = Date.parse("2026-11-24T12:00:00Z");
  let elapsed = 5_000;
  const sent: ActivityPush[] = [];
  const errors: unknown[] = [];
  const lifetime = new AbortController();
  const delivery = createActivityDelivery({
    store,
    gateway: {
      async sendActivity(_address, prepare) {
        const body = prepare();
        if (!body) return { status: "skipped" };
        sent.push(body);
        return { status: "sent" };
      },
    },
    targets: async () => [target],
    guard: () => () => true,
    drop: async () => {},
    requestSignal: () => lifetime.signal,
    preferences: async () => NotificationPreferences.parse({}),
    now: () => wall,
    monotonic: () => elapsed,
    delay: () => () => {},
    report: (error) => errors.push(error),
    signal: lifetime.signal,
  });
  cleanups.push(async () => {
    delivery.stop();
    lifetime.abort();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    store,
    thread,
    sent,
    errors,
    delivery,
    status: (status: ThreadStatus) =>
      store.appendEvents(thread, [{ type: "thread.updated", status }], wall),
    /** Both clocks move together, as they do when nobody sets the time. */
    advance(ms: number) {
      wall += ms;
      elapsed += ms;
    },
    /** Someone sets the machine's clock: wall time moves, elapsed time does not. */
    setClock(ms: number) {
      wall += ms;
    },
    wall: () => wall,
    read: () => delivery.run(),
    events: () => sent.map((push) => push.event),
  };
}

/** Busy, then quiet: the 120-second grace has begun. */
async function settled(activity: ReturnType<typeof lane>) {
  await activity.read();
  activity.status({ state: "working", agents: 1 });
  await activity.read();
  activity.advance(1000);
  activity.status({ state: "done" });
  await activity.read();
  expect(activity.events()).toEqual(["update"]);
}

it("a background command that starts and finishes between reads restarts the quiet grace", async () => {
  const activity = lane();
  await settled(activity);
  activity.advance(100_000);
  const task = BackgroundTaskId.parse("task-1");
  activity.store.appendEvents(activity.thread, [
    {
      type: "background_task.started",
      task: {
        id: task,
        agentId: AgentId.parse("root"),
        kind: "shell",
        title: "bun run build",
        status: "running",
        ambient: false,
        stoppable: true,
        startedAt: activity.wall(),
        raw: [],
      },
    },
    { type: "background_task.updated", taskId: task, status: "completed" },
  ]);
  // Past the deadline the first quiet read set, but seconds after the command finished.
  activity.advance(25_000);
  await activity.read();
  activity.advance(119_000);
  await activity.read();
  expect(activity.events()).not.toContain("end");
  activity.advance(1000);
  await activity.read();
  expect(activity.events().at(-1)).toBe("end");
  expect(activity.errors).toEqual([]);
});

it("a wall clock set forward does not cut the quiet grace short", async () => {
  const activity = lane();
  await settled(activity);
  activity.setClock(5 * 60_000);
  activity.advance(5000);
  // The phone resyncs: its tokens are read again and the lane runs at once.
  activity.delivery.refresh();
  await activity.read();
  activity.advance(114_000);
  await activity.read();
  expect(activity.events()).not.toContain("end");
  activity.advance(1000);
  await activity.read();
  expect(activity.events().at(-1)).toBe("end");
  // The wire still carries the machine's own wall time.
  expect(activity.sent.at(-1)?.state.at).toBe(Math.floor(activity.wall() / 1000));
  expect(activity.errors).toEqual([]);
});
