import { expect, it } from "vitest";
import {
  CommandFilesystemUnavailable,
  PosixLanes,
  type PosixExecutorEvents,
  type PosixLaneOptions,
} from "./posix-lanes.ts";
import type { PosixOperation } from "./posix-wire.ts";

interface FakeThread {
  events: PosixExecutorEvents;
  sent: { id: number; operation: PosixOperation }[];
  held: boolean;
  terminated: boolean;
  /** Answers the call it is running. */
  answer(value: number | string | null): void;
}

function harness(options: Partial<PosixLaneOptions> = {}) {
  const threads: FakeThread[] = [];
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const lanes = new PosixLanes({
    spawn(events) {
      const thread: FakeThread = {
        events,
        sent: [],
        held: false,
        terminated: false,
        answer(value) {
          const last = thread.sent.at(-1);
          if (!last) throw new Error("Nothing running");
          events.reply({ id: last.id, ok: true, value });
        },
      };
      threads.push(thread);
      return {
        send: (id, operation) => thread.sent.push({ id, operation }),
        hold: (busy) => {
          thread.held = busy;
        },
        terminate: () => {
          thread.terminated = true;
        },
      };
    },
    timer(run, ms) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    deadlineMs: 1000,
    idleMs: 5000,
    spares: 1,
    stuckPerRoot: 1,
    ...options,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((t) => t.at <= now)) {
      timers.delete(timer);
      timer.run();
    }
  };
  return { lanes, threads, advance };
}

const open = (name: string): PosixOperation => ({ op: "open", directory: 3, name, flags: 0 });
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const flush = () => new Promise((resolve) => setImmediate(resolve));

it("a call stuck under one root doesn't delay a call under another root", async () => {
  const { lanes, threads } = harness();
  void settle(lanes.run("/a", open("stuck")));
  const other = lanes.run("/b", open("prompt.md"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(7);
  await expect(other).resolves.toMatchObject({ value: 7 });
});

it("a stuck call fails at its deadline, with the calls queued behind it on that root", async () => {
  const { lanes, threads, advance } = harness();
  const stuck = settle(lanes.run("/a", open("stuck")));
  const queued = settle(lanes.run("/a", open("next")));
  advance(999);
  await flush();
  expect(threads[0]?.terminated).toBe(false);
  advance(1);
  expect((await stuck).error).toBeInstanceOf(CommandFilesystemUnavailable);
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  // The queued call never reached the stuck thread, and the thread is gone for good.
  expect(threads[0]?.sent.map((s) => s.operation)).toEqual([open("stuck")]);
  expect(threads[0]?.terminated).toBe(true);
  expect(threads[0]?.held).toBe(false);
});

it("a root whose thread was abandoned works again on a fresh thread", async () => {
  const { lanes, threads, advance } = harness({ stuckPerRoot: 2 });
  void settle(lanes.run("/a", open("stuck")));
  advance(1000);
  const again = lanes.run("/a", open("prompt.md"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(9);
  await expect(again).resolves.toMatchObject({ value: 9 });
  // A late answer from the abandoned thread changes nothing.
  threads[0]?.answer(4);
  expect(threads[1]?.terminated).toBe(false);
});

it("a root fails at once while too many of its threads are still stuck, until one returns", async () => {
  const { lanes, threads, advance } = harness();
  void settle(lanes.run("/a", open("stuck")));
  advance(1000);
  await expect(lanes.run("/a", open("again"))).rejects.toThrow("still not responding");
  expect(threads).toHaveLength(1);
  // Other roots are unaffected.
  const other = lanes.run("/b", open("ok"));
  threads[1]?.answer(5);
  await expect(other).resolves.toMatchObject({ value: 5 });
  threads[0]?.events.exit(new Error("exited"));
  const recovered = lanes.run("/a", open("again"));
  threads.at(-1)?.answer(6);
  await expect(recovered).resolves.toMatchObject({ value: 6 });
});

it("a directory stream dies with its abandoned thread and closes without a call", async () => {
  const { lanes, threads, advance } = harness({ stuckPerRoot: 2 });
  const opening = lanes.run("/a", { op: "openDirectory", fd: 3 });
  threads[0]?.answer(1);
  const { executor } = await opening;
  void settle(lanes.run("/a", { op: "readDirectory", reader: 1 }, { executor }));
  advance(1000);
  // The root has a fresh thread now, but the stream belonged to the abandoned one.
  const fresh = lanes.run("/a", open("x"));
  threads[1]?.answer(8);
  await fresh;
  const close = lanes.run("/a", { op: "closeDirectory", reader: 1 }, { executor });
  await expect(close).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
  expect(threads[1]?.sent.map((s) => s.operation.op)).toEqual(["open"]);
});

it("cancelling a queued call drops it unrun; cancelling a running call abandons its thread", async () => {
  const { lanes, threads } = harness({ stuckPerRoot: 2 });
  const running = new AbortController();
  const queued = new AbortController();
  const first = settle(lanes.run("/a", open("first"), { signal: running.signal }));
  const second = settle(lanes.run("/a", open("second"), { signal: queued.signal }));
  queued.abort(new Error("gone"));
  expect(await second).toMatchObject({ error: { message: "gone" } });
  running.abort(new Error("closing"));
  expect(await first).toMatchObject({ error: { message: "closing" } });
  expect(threads[0]?.sent.map((s) => s.operation)).toEqual([open("first")]);
  expect(threads[0]?.terminated).toBe(true);
  await expect(
    lanes.run("/a", open("third"), { signal: AbortSignal.abort(new Error("already")) }),
  ).rejects.toThrow("already");
});

it("an idle thread is lent to the next root, then terminated after the idle period", async () => {
  const { lanes, threads, advance } = harness();
  const first = lanes.run("/a", open("x"));
  expect(threads[0]?.held).toBe(true);
  threads[0]?.answer(3);
  await first;
  // Between calls the thread doesn't keep the process alive.
  expect(threads[0]?.held).toBe(false);
  const second = lanes.run("/b", open("y"));
  expect(threads).toHaveLength(1);
  threads[0]?.answer(4);
  await second;
  advance(5000);
  expect(threads[0]?.terminated).toBe(true);
  const third = lanes.run("/c", open("z"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(5);
  await expect(third).resolves.toMatchObject({ value: 5 });
});

it("a thread with an open directory stream stays with its root until the stream closes", async () => {
  const { lanes, threads } = harness();
  const opening = lanes.run("/a", { op: "openDirectory", fd: 3 });
  threads[0]?.answer(1);
  const { executor } = await opening;
  void settle(lanes.run("/b", open("y")));
  expect(threads).toHaveLength(2);
  const close = lanes.run("/a", { op: "closeDirectory", reader: 1 }, { executor });
  threads[0]?.answer(0);
  await close;
  const reused = lanes.run("/c", open("z"));
  expect(threads).toHaveLength(2);
  threads[0]?.answer(6);
  await expect(reused).resolves.toMatchObject({ value: 6 });
});

it("a thread that crashes fails its root's calls and the next call starts a new one", async () => {
  const { lanes, threads } = harness();
  const lost = settle(lanes.run("/a", open("x")));
  threads[0]?.events.exit(new Error("Command discovery worker exited"));
  expect(await lost).toMatchObject({ error: { message: "Command discovery worker exited" } });
  const next = lanes.run("/a", open("y"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(2);
  await expect(next).resolves.toMatchObject({ value: 2 });
});
