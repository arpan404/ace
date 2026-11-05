import { expect, it } from "vitest";
import {
  CommandFilesystemUnavailable,
  CommandWriteOutcomeUnknown,
  PosixCallOwner,
  PosixLanes,
  type PosixExecutorEvents,
  type PosixLaneOptions,
} from "./posix-lanes.ts";
import type { PosixOperation } from "./posix-wire.ts";

interface FakeThread {
  events: PosixExecutorEvents;
  sent: { id: number; operation: PosixOperation }[];
  held: boolean;
  /** Set once told to drain; `abandoned` names the call whose result it must release. */
  drained?: { abandoned?: number | undefined };
  /** Answers the call it is running. */
  answer(value: number | string | null): void;
  exit(): void;
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
        answer(value) {
          const last = thread.sent.at(-1);
          if (!last) throw new Error("Nothing running");
          events.reply({ id: last.id, ok: true, value });
        },
        exit: () => events.exit(new Error("Command discovery worker exited")),
      };
      threads.push(thread);
      return {
        send: (id, operation) => thread.sent.push({ id, operation }),
        hold: (busy) => {
          thread.held = busy;
        },
        drain: (abandoned) => {
          thread.drained = { abandoned };
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
    maxWorkers: 8,
    maxThreads: 16,
    ...options,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((t) => t.at <= now)) {
      // An earlier timer in this pass may have cancelled it.
      if (timers.delete(timer)) timer.run();
    }
  };
  return { lanes, threads, advance };
}

const open = (name: string): PosixOperation => ({ op: "open", directory: 3, name, flags: 0 });
const rename: PosixOperation = {
  op: "rename",
  from: 3,
  fromName: ".prompt-1",
  to: 3,
  toName: "a.md",
  flags: 0,
};
const settle = <T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ops = (thread: FakeThread | undefined) => thread?.sent.map((s) => s.operation);

it("a call stuck under one root doesn't delay a call under another root", async () => {
  const { lanes, threads } = harness();
  void settle(lanes.run("/a", open("stuck")));
  const other = lanes.run("/b", open("prompt.md"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(7);
  await expect(other).resolves.toMatchObject({ value: 7 });
});

it("a stuck call fails at its deadline with the calls queued behind it, and its thread drains", async () => {
  const { lanes, threads, advance } = harness();
  const stuck = settle(lanes.run("/a", open("stuck")));
  const queued = settle(lanes.run("/a", open("next")));
  advance(999);
  await flush();
  expect(threads[0]?.drained).toBeUndefined();
  advance(1);
  expect((await stuck).error).toBeInstanceOf(CommandFilesystemUnavailable);
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  // The queued call never reached the stuck thread. The thread is told which call it must
  // release when it returns, and no longer keeps the process alive.
  expect(ops(threads[0])).toEqual([open("stuck")]);
  expect(threads[0]?.drained).toEqual({ abandoned: threads[0]?.sent[0]?.id });
  expect(threads[0]?.held).toBe(false);
});

it("a root whose thread is draining still reads on a fresh thread", async () => {
  const { lanes, threads, advance } = harness({ stuckPerRoot: 2 });
  void settle(lanes.run("/a", open("stuck")));
  advance(1000);
  const again = lanes.run("/a", open("prompt.md"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(9);
  await expect(again).resolves.toMatchObject({ value: 9 });
  // A late answer from the draining thread changes nothing.
  threads[0]?.answer(4);
  expect(threads[1]?.drained).toBeUndefined();
});

it("a timed-out change reports an unknown outcome, and later changes wait until it has returned", async () => {
  const { lanes, threads, advance } = harness({ stuckPerRoot: 2 });
  const save = settle(lanes.run("/a", rename));
  advance(1000);
  expect((await save).error).toBeInstanceOf(CommandWriteOutcomeUnknown);
  // A second save could race the first one's rename; it fails at once, before reaching a thread.
  await expect(lanes.run("/a", { ...rename, fromName: ".prompt-2" })).rejects.toThrow(
    "hasn't finished",
  );
  expect(threads).toHaveLength(1);
  threads[0]?.exit();
  const after = lanes.run("/a", { ...rename, fromName: ".prompt-3" });
  threads[1]?.answer(0);
  await expect(after).resolves.toMatchObject({ value: 0 });
});

it("a root fails at once while too many of its threads are draining, until one exits", async () => {
  const { lanes, threads, advance } = harness();
  void settle(lanes.run("/a", open("stuck")));
  advance(1000);
  await expect(lanes.run("/a", open("again"))).rejects.toThrow("still not responding");
  expect(threads).toHaveLength(1);
  const other = lanes.run("/b", open("ok"));
  threads[1]?.answer(5);
  await expect(other).resolves.toMatchObject({ value: 5 });
  threads[0]?.exit();
  const recovered = lanes.run("/a", open("again"));
  threads.at(-1)?.answer(6);
  await expect(recovered).resolves.toMatchObject({ value: 6 });
});

it("a directory stream dies with its draining thread and closes without a call", async () => {
  const { lanes, threads, advance } = harness({ stuckPerRoot: 2 });
  const opening = lanes.run("/a", { op: "openDirectory", fd: 3 });
  threads[0]?.answer(1);
  const { executor } = await opening;
  void settle(lanes.run("/a", { op: "readDirectory", reader: 1 }, { executor }));
  advance(1000);
  const fresh = lanes.run("/a", open("x"));
  threads[1]?.answer(8);
  await fresh;
  const close = lanes.run("/a", { op: "closeDirectory", reader: 1 }, { executor });
  await expect(close).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
  expect(ops(threads[1])?.map((op) => op.op)).toEqual(["open"]);
});

it("cancelling one owner leaves another owner's calls on the same root running in order", async () => {
  const { lanes, threads } = harness();
  const closing = new PosixCallOwner(lanes);
  const staying = new PosixCallOwner(lanes);
  const running = settle(closing.run("/a", open("first")));
  const queued = settle(closing.run("/a", open("second")));
  const other = staying.run("/a", open("theirs"));
  closing.cancel();
  // Both of the cancelled owner's calls end now, without waiting for the thread.
  expect((await running).error).toBeInstanceOf(CommandFilesystemUnavailable);
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  let idle = false;
  void closing.idle().then(() => (idle = true));
  await flush();
  expect(idle).toBe(false);
  // The running open still returns a descriptor. Nobody asked for it any more, so the same
  // thread closes it before running the other owner's call.
  threads[0]?.answer(11);
  await flush();
  expect(idle).toBe(true);
  expect(ops(threads[0])).toEqual([open("first"), { op: "closeFd", fd: 11 }]);
  threads[0]?.answer(0);
  expect(ops(threads[0])?.at(-1)).toEqual(open("theirs"));
  threads[0]?.answer(12);
  await expect(other).resolves.toMatchObject({ value: 12 });
  await expect(closing.run("/a", open("late"))).rejects.toThrow("closed");
});

it("an owner is idle one deadline after cancelling, however many of its roots are stuck", async () => {
  const { lanes, advance } = harness();
  const owner = new PosixCallOwner(lanes);
  for (const root of ["/a", "/b", "/c"]) void settle(owner.run(root, open("stuck")));
  owner.cancel();
  let idle = false;
  void owner.idle().then(() => (idle = true));
  advance(999);
  await flush();
  expect(idle).toBe(false);
  advance(1);
  await flush();
  expect(idle).toBe(true);
});

it("an idle thread is lent to the next root, then drained after the idle period", async () => {
  const { lanes, threads, advance } = harness();
  const first = lanes.run("/a", open("x"));
  expect(threads[0]?.held).toBe(true);
  threads[0]?.answer(3);
  await first;
  expect(threads[0]?.held).toBe(false);
  const second = lanes.run("/b", open("y"));
  expect(threads).toHaveLength(1);
  threads[0]?.answer(4);
  await second;
  advance(5000);
  // Nothing was abandoned, so it has nothing to release beyond its own streams.
  expect(threads[0]?.drained).toEqual({ abandoned: undefined });
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
  threads[0]?.exit();
  expect(await lost).toMatchObject({ error: { message: "Command discovery worker exited" } });
  const next = lanes.run("/a", open("y"));
  expect(threads).toHaveLength(2);
  threads[1]?.answer(2);
  await expect(next).resolves.toMatchObject({ value: 2 });
});

it("many roots on one dead mount never start more threads than the cap", async () => {
  const { lanes, threads, advance } = harness({ maxWorkers: 3, maxThreads: 5 });
  const calls = Array.from({ length: 10 }, (_, i) => settle(lanes.run(`/dead/${i}`, open("x"))));
  expect(threads).toHaveLength(3);
  // The first three stall and drain; two more threads fit under the cap, then roots wait.
  advance(1000);
  expect(threads).toHaveLength(5);
  expect(lanes.threads()).toBe(5);
  advance(1000);
  const results = await Promise.all(calls);
  expect(threads).toHaveLength(5);
  const messages = results.map((r) => (r.error instanceof Error ? r.error.message : ""));
  expect(messages.filter((m) => m === "Command folder stopped responding")).toHaveLength(5);
  expect(messages.filter((m) => m === "Too many command folders are busy")).toHaveLength(5);
  // While every thread is stuck a healthy root waits; once one returns it is served.
  const healthy = lanes.run("/home/prompts", open("ok"));
  threads[0]?.exit();
  expect(threads).toHaveLength(6);
  threads[5]?.answer(4);
  await expect(healthy).resolves.toMatchObject({ value: 4 });
});

it("a root waiting for a thread takes the next one another root lets go", async () => {
  const { lanes, threads } = harness({ maxWorkers: 1, spares: 0 });
  const first = lanes.run("/a", open("x"));
  const waiting = lanes.run("/b", open("y"));
  expect(threads).toHaveLength(1);
  threads[0]?.answer(1);
  await first;
  expect(ops(threads[0])?.at(-1)).toEqual(open("y"));
  threads[0]?.answer(2);
  await expect(waiting).resolves.toMatchObject({ value: 2 });
});
