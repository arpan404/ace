import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { facts, FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { CommandId, DeviceId, HostId, ThreadId } from "@ace/protocol";
import { until } from "./test-host.ts";
import { later } from "./spade-test-host.ts";
import { SpadeWorkerWatch } from "./spade-worker-watch.ts";

/*
 * A worker the thread list doesn't hold (archived) is read from its own thread through an optional
 * subscription, which the SDK refuses while the room is taken. Over the real SDK with room for
 * three optional holds: two refused workers are read again as room frees up, one slot at a time,
 * and the walk of room listeners never loops.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

const busyA = ThreadId.parse("busy-a");
const busyB = ThreadId.parse("busy-b");
const busyC = ThreadId.parse("busy-c");
const first = ThreadId.parse("worker-1");
const second = ThreadId.parse("worker-2");
const names = [busyA, busyB, busyC, first, second];

async function setUp() {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "watch-host", token: "t" });
  for (const id of names) {
    daemon.createThread({ id, workspaceId: "ace", title: id, provider: "claude", access: "ask" });
    daemon.apply(id, [facts.rootAgent("claude"), facts.turn("root"), facts.endTurn("root")]);
  }
  // The workers are archived, so the thread list no longer holds them.
  for (const id of [first, second])
    daemon.command({
      id: CommandId.parse(`archive-${id}`),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.archive", threadId: id },
    });
  const owner = new ClientCore({
    deviceId: DeviceId.parse("watch-test"),
    expectedHostId: HostId.parse("watch-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: later },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
    // Room for three optional holds.
    limits: { threads: 4, threadReserve: 1 },
  });
  stops.push(() => owner.close());
  await owner.start();
  await until(() => owner.state === "ready");
  return owner;
}

test("two workers refused for lack of room are each read again as room frees up", async () => {
  const owner = await setUp();
  const list = owner.threads();
  stops.push(() => list.release());
  await until(() => list.store.loaded && !list.store.unconfirmed && !list.store.syncing);
  // The list holds the three busy threads only.
  const holds = [busyA, busyB, busyC].map((id) => owner.thread(id, { optional: true }));
  expect(owner.threadRoom().getSnapshot()).toBe(0);

  let changes = 0;
  // What each redraw saw: the bridge reads every worker again when told. The redraw itself is the
  // only reader, so a worker settling here was read by the notification, not by the test.
  const seen: Record<string, string | undefined>[] = [];
  const redraw = () => {
    changes++;
    seen.push(Object.fromEntries([first, second].map((id) => [id, read(id)?.state])));
  };
  const watch: SpadeWorkerWatch = new SpadeWorkerWatch(owner, redraw);
  stops.push(() => watch.stop());
  const read = (thread: string) =>
    watch
      .facts(
        () => undefined,
        () => undefined,
      )
      .listed(thread);

  expect(read(first)).toBeUndefined();
  expect(read(second)).toBeUndefined();

  // One slot frees: the redraw reads the freed slot into exactly one worker, and nothing loops.
  holds[0]?.release();
  await until(() => seen.some((read) => Object.values(read).includes("done")));
  const settled = changes;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(changes).toBe(settled);
  expect(Object.values(seen.at(-1) ?? {}).filter((state) => state === "done")).toHaveLength(1);

  // The next slot frees: the other worker is read too.
  holds[1]?.release();
  await until(() => Object.values(seen.at(-1) ?? {}).every((state) => state === "done"));
});

test("a retry queued before stop does not redraw after the watch restarts in the same turn", async () => {
  const owner = await setUp();
  const list = owner.threads();
  stops.push(() => list.release());
  await until(() => list.store.loaded && !list.store.unconfirmed && !list.store.syncing);
  const holds = [busyA, busyB, busyC].map((id) => owner.thread(id, { optional: true }));

  let changes = 0;
  const watch = new SpadeWorkerWatch(owner, () => changes++);
  stops.push(() => watch.stop());
  const read = () =>
    watch
      .facts(
        () => undefined,
        () => undefined,
      )
      .listed(first);
  expect(read()).toBeUndefined();

  // Room frees (queueing the retry), then the chat closes and the next one opens in the same turn.
  holds[0]?.release();
  watch.stop();
  // The next conversation starts: the list is held again, and no worker is read from its thread,
  // so nothing but the old retry could redraw it.
  watch.facts(
    () => undefined,
    () => undefined,
  ).waiting(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(changes).toBe(0);
});
