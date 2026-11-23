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
  await until(() => seen.some((states) => Object.values(states).includes("done")));
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
  // The next conversation starts: the list is held again. It walks a listed worker with no hints, so
  // no thread is read from its own (an unlisted one would load and rightly redraw), and nothing but
  // the old retry could redraw it.
  watch
    .facts(
      () => undefined,
      () => undefined,
    )
    .waiting(busyA);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(changes).toBe(0);
});

const live = (asking: string[]) => ({ askingThreads: asking.map((id) => ({ id })) });

const entry = (id: string, asking: string[]) => ({
  id,
  status: { state: "needs_you", interactions: 1 },
  live: live(asking),
});

/** A thread list and threads as the SDK hands them out, settled until told otherwise. */
function fakeOwner(listed: Record<string, string[]>, unlisted: Record<string, string[]>) {
  const list = {
    loaded: true,
    unconfirmed: false,
    syncing: false,
    error: undefined as unknown,
    ids: Object.keys(listed),
    thread: (id: string) => (id in listed ? entry(id, listed[id] ?? []) : undefined),
    observe: () => () => {},
  };
  const held = new Set<string>();
  const owner = {
    threads: () => ({ store: list, release: () => {} }),
    thread: (id: string) => {
      held.add(id);
      return {
        store: {
          error: undefined,
          syncing: false,
          unconfirmed: false,
          thread: id in unlisted ? entry(id, unlisted[id] ?? []) : undefined,
          observe: () => () => {},
        },
        release: () => held.delete(id),
      };
    },
    threadRoom: () => ({ subscribe: () => () => {}, getSnapshot: () => 1 }),
  };
  return {
    list,
    held,
    owner: owner as unknown as ConstructorParameters<typeof SpadeWorkerWatch>[0],
  };
}

const workersRow = (thread: string, asking: string[]) => ({
  row: {
    kind: "workers" as const,
    title: "",
    workers: [
      {
        id: thread,
        name: "",
        kind: "ace" as const,
        thread,
        asking,
        conversation: null,
        tone: "needs-you" as const,
        line: "",
      },
    ],
  },
});

test("a worker's asking threads stop at the cap even when one thread hints at many", () => {
  const children = Array.from({ length: 8 }, (_, at) => `child-${at}`);
  const tree: Record<string, string[]> = { worker: children };
  for (const child of children) tree[child] = [0, 1, 2].map((at) => `${child}-${at}`);
  for (const child of children) for (const leaf of tree[child] ?? []) tree[leaf] = [];
  const { owner } = fakeOwner(tree, {});
  const watch = new SpadeWorkerWatch(owner, () => {});
  const waiting = watch
    .facts(
      () => undefined,
      () => undefined,
    )
    .waiting("worker");
  // The worker, then at most 16 below it.
  expect(waiting).toHaveLength(17);
  expect(waiting.slice(1, 9)).toEqual(children);
});

test("a worker keeps the threads it named below it while the list is syncing", () => {
  const { list, held, owner } = fakeOwner(
    { worker: ["middle"], deepest: [] },
    { middle: ["deepest"] },
  );
  const watch = new SpadeWorkerWatch(owner, () => {});
  const read = () =>
    watch
      .facts(
        () => undefined,
        () => undefined,
      )
      .waiting("worker");
  expect(read()).toEqual(["worker", "middle", "deepest"]);
  watch.showing([workersRow("worker", read())]);

  list.syncing = true;
  const during = read();
  watch.showing([workersRow("worker", during)]);

  expect(during).toEqual(["worker", "middle", "deepest"]);
  // The unlisted middle thread is still read from its own thread, not dropped and taken again.
  expect(held.has("middle")).toBe(true);
});
