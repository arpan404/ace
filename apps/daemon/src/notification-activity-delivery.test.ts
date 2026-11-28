import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ActivityPush } from "@ace/notify";
import {
  AgentId,
  BackgroundTaskId,
  DeviceId,
  NotificationPreferences,
  type ThreadStatus,
} from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { createActivityDelivery } from "./notification-activity-delivery.ts";
import type { LiveActivitySendTarget } from "./notification-live-activity.ts";
import { ChildLedger } from "./machines/child-ledger.ts";
import { Store } from "./store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const target: LiveActivitySendTarget = {
  token: "b2".repeat(32),
  environment: "sandbox",
  kind: "liveactivity",
  frequentUpdates: true,
  slot: 0,
  devices: [DeviceId.parse("phone")],
  binding: 1,
};

/** One phone's activity on a temp store. Reads happen only when the test calls `read`. */
function lane() {
  const home = mkdtempSync(join(tmpdir(), "ace-activity-"));
  const store = new Store(join(home, "events.sqlite"));
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo")).id;
  let wall = Date.parse("2026-11-24T12:00:00Z");
  let elapsed = 5_000;
  const sent: ActivityPush[] = [];
  /** The timers the lane armed and that haven't fired, by when they come due. */
  const timers: { at: number; run: () => void }[] = [];
  /** How many times one of them fired. */
  let fired = 0;
  const errors: unknown[] = [];
  const lifetime = new AbortController();
  const ledger = new ChildLedger(store);
  /** Times the lane read the threads' revisions: once each time it builds the activity's state. */
  let snapshots = 0;
  const atomic = store.atomic.bind(store);
  const counted = new Proxy(store, {
    get(base, prop) {
      if (prop === "atomic")
        return <T>(run: (db: import("node:sqlite").DatabaseSync) => T) =>
          atomic((db) =>
            run(
              new Proxy(db, {
                get(inner, key) {
                  if (key === "prepare")
                    return (sql: string) => {
                      if (sql.includes("FROM sidebar_thread_revisions")) snapshots++;
                      return inner.prepare(sql);
                    };
                  const value: unknown = Reflect.get(inner, key, inner);
                  return typeof value === "function" ? value.bind(inner) : value;
                },
              }),
            ),
          );
      const value: unknown = Reflect.get(base, prop, base);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
  /** While set, a send waits for it before it prepares its body, as a slow gateway lookup does. */
  let paused: Promise<void> | undefined;
  const delivery = createActivityDelivery({
    store: counted,
    remoteWatched: () => ledger.watchingRemote(),
    gateway: {
      async sendActivity(_address, prepare) {
        if (paused) await paused;
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
    delay: (run, ms) => {
      const timer = { at: elapsed + ms, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
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
    elapsed: () => elapsed,
    read: () => delivery.run(),
    snapshots: () => snapshots,
    /** The next sends wait in the gateway until `release`. */
    pauseSends() {
      const gate = Promise.withResolvers<void>();
      paused = gate.promise;
      return () => {
        paused = undefined;
        gate.resolve();
      };
    },
    fired: () => fired,
    /**
     * Time passes `ms`: each timer the lane armed fires when it comes due, and the run it starts
     * finishes before the next. Nothing else starts a run.
     */
    async tick(ms: number) {
      const until = elapsed + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        const step = Math.max(0, next.at - elapsed);
        wall += step;
        elapsed += step;
        fired++;
        next.run();
        for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
      }
      wall += until - elapsed;
      elapsed = until;
    },
    /** A child this machine delegated to another one, as the machines ledger records it. */
    remoteChild(id: string, state: { settled: boolean; settledAt?: number }) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO machine_children (id, request_key, parent_thread, parent_agent,
              machine, role, provider, created_at, view, settled, delivered, settled_at)
            VALUES (?, ?, ?, 'agent', 'studio', 'Task', 'claude', 0, NULL, ?, 1, ?)`,
          )
          .run(id, `${thread}:${id}`, thread, state.settled ? 1 : 0, state.settledAt ?? null),
      );
    },
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

it("end waits while a child on another machine is working, and while a settled one is in its window", async () => {
  const activity = lane();
  activity.remoteChild("remote-a", { settled: false });
  await settled(activity);
  activity.advance(121_000);
  await activity.read();
  expect(activity.events()).not.toContain("end");
  // It finished there, and this machine is quiet. Its re-check window is open for a day: it may
  // start again there, so no end goes however long the grace has run.
  activity.remoteChild("remote-a", { settled: true, settledAt: activity.wall() });
  await activity.read();
  activity.advance(121_000);
  await activity.read();
  activity.advance(60 * 60_000);
  await activity.read();
  expect(activity.events()).not.toContain("end");
  // A day on, its last check answered, the re-check lets it go; the machine has long been quiet.
  activity.advance(24 * 60 * 60_000);
  activity.remoteChild("remote-a", { settled: true });
  await activity.read();
  expect(activity.events().at(-1)).toBe("end");
});

it("an end held for a remote child is looked at again on the lane's timer, once a second", async () => {
  const activity = lane();
  await settled(activity);
  // Settled there a moment ago: inside its window, so it holds the end.
  activity.remoteChild("remote-a", { settled: true, settledAt: activity.wall() });
  await activity.tick(121_000);
  const before = activity.fired();
  await activity.tick(10_000);
  // About one look a second, no loop, and still no end.
  expect(activity.fired() - before).toBeGreaterThanOrEqual(9);
  expect(activity.fired() - before).toBeLessThanOrEqual(11);
  expect(activity.events()).not.toContain("end");
});

it("a held end checks only the remote children on each tick, not the whole activity", async () => {
  const activity = lane();
  await settled(activity);
  activity.remoteChild("remote-a", { settled: true, settledAt: activity.wall() });
  await activity.tick(121_000);
  const before = activity.snapshots();
  await activity.tick(10_000);
  // Ten ticks with nothing changed: the activity's state is not built again.
  expect(activity.snapshots() - before).toBeLessThanOrEqual(1);
  expect(activity.events()).not.toContain("end");
  // Its window closes: the state is read again and the end goes.
  activity.remoteChild("remote-a", { settled: true });
  await activity.tick(2000);
  expect(activity.events().at(-1)).toBe("end");
});

it("a delegation that lands while the end waits on the gateway holds it", async () => {
  const activity = lane();
  await settled(activity);
  activity.advance(121_000);
  const release = activity.pauseSends();
  const sending = activity.read();
  await new Promise((resolve) => setImmediate(resolve));
  // The parent delegates to another machine while the gateway looks up the handle.
  activity.remoteChild("remote-a", { settled: false });
  release();
  await sending;
  expect(activity.events()).not.toContain("end");
});
