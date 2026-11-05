import { expect, it } from "vitest";
import { PosixLanes } from "./posix-lanes.ts";
import type { PosixExecutorEvents, PosixLaneOptions } from "./posix-executor.ts";
import { PosixCallOwner } from "./posix-owner.ts";
import {
  CommandFilesystemUnavailable,
  CommandWriteOutcomeUnknown,
  created,
  createdBy,
} from "./posix-ops.ts";
import type { PosixOperation } from "./posix-wire.ts";

interface FakeThread {
  events: PosixExecutorEvents;
  sent: { id: number; operation: PosixOperation }[];
  held: boolean;
  drained: boolean;
  /** The descriptor number behind each handle this thread holds, as the OS would hand it out. */
  fds: Map<number, number>;
  /** Answers the call it is running. */
  answer(value: number | string | null): void;
  exit(): void;
}

function harness(options: Partial<PosixLaneOptions> = {}) {
  const threads: FakeThread[] = [];
  // Descriptor numbers are per process and the lowest free one is reused at once.
  const inUse = new Set<number>();
  const lowestFree = () => {
    let fd = 3;
    while (inUse.has(fd)) fd++;
    inUse.add(fd);
    return fd;
  };
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const lanes = new PosixLanes({
    spawn(events) {
      const thread: FakeThread = {
        events,
        sent: [],
        held: false,
        drained: false,
        fds: new Map(),
        answer(value) {
          const last = thread.sent.at(-1);
          if (!last) throw new Error("Nothing running");
          const { operation } = last;
          const handle = createdBy(operation);
          if (handle !== undefined && created(operation, value))
            thread.fds.set(handle, lowestFree());
          if (operation.op === "close") {
            inUse.delete(thread.fds.get(operation.handle) ?? -1);
            thread.fds.delete(operation.handle);
          }
          events.reply({ id: last.id, ok: true, value });
        },
        exit() {
          // A thread closes what it owns as it drains.
          for (const fd of thread.fds.values()) inUse.delete(fd);
          thread.fds.clear();
          events.exit();
        },
      };
      threads.push(thread);
      return {
        send: (id, operation) => thread.sent.push({ id, operation }),
        hold: (busy) => {
          thread.held = busy;
        },
        drain: () => {
          thread.drained = true;
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
  /** Opens `root` on `thread` and returns its handle. */
  const open = async (root: string, thread: () => FakeThread | undefined) => {
    const handle = lanes.allocate();
    const opening = lanes.run(root, { op: "openPath", path: root, handle });
    thread()?.answer(0);
    await opening;
    return handle;
  };
  return { lanes, threads, advance, open };
}

const child = (directory: number, name: string, handle: number): PosixOperation => ({
  op: "open",
  directory,
  name,
  flags: 0,
  handle,
});
const settle = <T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ops = (thread: FakeThread | undefined) => thread?.sent.map((s) => s.operation) ?? [];
const fstat = (fd: number): PosixOperation => ({ op: "fstat", fd });

it("a call stuck under one root doesn't delay a call under another root", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  void settle(lanes.run("/a", fstat(a)));
  const b = open("/b", () => threads[1]);
  expect(threads).toHaveLength(2);
  await expect(b).resolves.toBeGreaterThan(a);
});

it("a stuck call fails at its deadline with the calls queued behind it, and its thread drains", async () => {
  const { lanes, threads, advance, open } = harness();
  const a = await open("/a", () => threads[0]);
  const stuck = settle(lanes.run("/a", fstat(a)));
  const queued = settle(lanes.run("/a", { op: "readLink", directory: a, name: "x" }));
  advance(999);
  await flush();
  expect(threads[0]?.drained).toBe(false);
  advance(1);
  expect((await stuck).error).toBeInstanceOf(CommandFilesystemUnavailable);
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  // The queued call never reached the stuck thread, which is told to drain and no longer keeps
  // the process alive.
  expect(ops(threads[0]).map((op) => op.op)).toEqual(["openPath", "fstat"]);
  expect(threads[0]?.drained).toBe(true);
  expect(threads[0]?.held).toBe(false);
});

it("a handle from a drained thread is dead, while a fresh handle on the same descriptor number works", async () => {
  const { lanes, threads, advance, open } = harness({ stuckPerRoot: 2 });
  const old = await open("/a", () => threads[0]);
  const number = threads[0]?.fds.get(old);
  void settle(lanes.run("/a", fstat(old)));
  advance(1000);
  // The stuck call returns at last; the thread closes everything it owns and exits.
  threads[0]?.answer(0);
  threads[0]?.exit();
  // The root opens again on a new thread, and the OS hands out the same number again.
  const fresh = await open("/a", () => threads[1]);
  expect(threads[1]?.fds.get(fresh)).toBe(number);
  // The old handle fails at once and its close goes nowhere: the new thread never hears of it.
  await expect(lanes.run("/a", fstat(old))).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
  lanes.close(old);
  expect(ops(threads[1])).toEqual([{ op: "openPath", path: "/a", handle: fresh }]);
  // The fresh handle is the new thread's own.
  const stat = lanes.run("/a", fstat(fresh));
  threads[1]?.answer(0);
  await stat;
  expect(ops(threads[1]).at(-1)).toEqual(fstat(fresh));
  lanes.close(fresh);
  expect(ops(threads[1]).at(-1)).toEqual({ op: "close", handle: fresh });
});

it("a timed-out change reports an unknown outcome, and later changes wait until it has returned", async () => {
  const { lanes, threads, advance, open } = harness({ stuckPerRoot: 2 });
  const a = await open("/a", () => threads[0]);
  const rename = (from: string): PosixOperation => ({
    op: "rename",
    from: a,
    fromName: from,
    to: a,
    toName: "a.md",
    flags: 0,
  });
  const save = settle(lanes.run("/a", rename(".prompt-1")));
  advance(1000);
  expect((await save).error).toBeInstanceOf(CommandWriteOutcomeUnknown);
  const b = await open("/a", () => threads[1]);
  // A second save could race the first one's rename; it fails at once, before reaching a thread.
  await expect(
    lanes.run("/a", { op: "mkdir", directory: b, name: "x", mode: 0o700 }),
  ).rejects.toThrow("hasn't finished");
  threads[0]?.exit();
  const after = lanes.run("/a", { op: "mkdir", directory: b, name: "x", mode: 0o700 });
  threads[1]?.answer(0);
  await expect(after).resolves.toMatchObject({ value: 0 });
});

it("a root fails at once while too many of its threads are draining, until one exits", async () => {
  const { lanes, threads, advance, open } = harness();
  const a = await open("/a", () => threads[0]);
  void settle(lanes.run("/a", fstat(a)));
  advance(1000);
  const again = lanes.allocate();
  await expect(lanes.run("/a", { op: "openPath", path: "/a", handle: again })).rejects.toThrow(
    "still not responding",
  );
  expect(threads).toHaveLength(1);
  await open("/b", () => threads[1]);
  threads[0]?.exit();
  await open("/a", () => threads[2]);
});

it("a thread stays with its root while it holds handles, and is lent on once they are closed", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  await open("/b", () => threads[1]);
  expect(threads).toHaveLength(2);
  lanes.close(a);
  threads[0]?.answer(0);
  await flush();
  await open("/c", () => threads[0]);
  expect(threads).toHaveLength(2);
});

it("cancelling one owner leaves another owner's calls on the same root running in order", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  const closing = new PosixCallOwner(lanes);
  const staying = new PosixCallOwner(lanes);
  const first = lanes.allocate();
  const running = settle(closing.run("/a", child(a, "first", first)));
  const queued = settle(closing.run("/a", child(a, "second", lanes.allocate())));
  const theirs = lanes.allocate();
  const other = staying.run("/a", child(a, "theirs", theirs));
  closing.cancel();
  // Both of the cancelled owner's calls end now, without waiting for the thread.
  expect((await running).error).toBeInstanceOf(CommandFilesystemUnavailable);
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  // The running open still succeeds. Nobody asked for it any more, so the same thread closes it
  // before running the other owner's call.
  threads[0]?.answer(0);
  expect(ops(threads[0]).at(-1)).toEqual({ op: "close", handle: first });
  threads[0]?.answer(0);
  expect(ops(threads[0]).at(-1)).toEqual(child(a, "theirs", theirs));
  threads[0]?.answer(0);
  await expect(other).resolves.toMatchObject({ value: 0 });
  await expect(closing.run("/a", fstat(a))).rejects.toThrow("closed");
});

it("closing a handle a running call names is done at once and reaches its thread after the call", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  const owner = new PosixCallOwner(lanes);
  // Sent, but the thread may not have reached openat yet: the caller gives up and closes `a`.
  const opening = settle(owner.run("/a", child(a, "x", lanes.allocate())));
  owner.cancel();
  await opening;
  lanes.close(a);
  expect(ops(threads[0]).map((op) => op.op)).toEqual(["openPath", "open"]);
  threads[0]?.answer(0);
  threads[0]?.answer(0);
  expect(ops(threads[0]).map((op) => op.op)).toEqual(["openPath", "open", "close", "close"]);
});

it("listDirectory takes its handle over, and a call that never runs closes it on its thread", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  const listed = await open("/a", () => threads[0]);
  const owner = new PosixCallOwner(lanes);
  void settle(lanes.run("/a", fstat(a)));
  const queued = settle(owner.run("/a", { op: "listDirectory", fd: listed, limit: 10 }));
  owner.cancel();
  expect((await queued).error).toBeInstanceOf(CommandFilesystemUnavailable);
  // The handle is no longer the caller's: using or closing it does nothing.
  await expect(lanes.run("/a", fstat(listed))).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
  lanes.close(listed);
  threads[0]?.answer(0);
  expect(ops(threads[0]).filter((op) => op.op === "close")).toEqual([
    { op: "close", handle: listed },
  ]);
});

it("closes on stuck threads never start threads, so caps hold on a dead mount", async () => {
  const { lanes, threads, advance, open } = harness({
    maxWorkers: 2,
    maxThreads: 2,
    stuckPerRoot: 2,
  });
  const a = await open("/dead/a", () => threads[0]);
  const b = await open("/dead/b", () => threads[1]);
  void settle(lanes.run("/dead/a", fstat(a)));
  void settle(lanes.run("/dead/b", fstat(b)));
  advance(1000);
  for (let i = 0; i < 10; i++) {
    lanes.close(a);
    lanes.close(b);
  }
  expect(threads).toHaveLength(2);
  expect(threads.flatMap((t) => ops(t)).filter((op) => op.op === "close")).toEqual([]);
  // Every thread is stuck, filling the reserve: a new root gets no thread and fails at once.
  await expect(
    lanes.run("/home", { op: "openPath", path: "/home", handle: lanes.allocate() }),
  ).rejects.toThrow("Too many command folders stopped responding");
  expect(threads).toHaveLength(2);
});

it("a cancelled change running on its thread reports that its outcome is unknown", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  const owner = new PosixCallOwner(lanes);
  const save = settle(
    owner.run("/a", { op: "rename", from: a, fromName: ".t", to: a, toName: "a.md", flags: 0 }),
  );
  owner.cancel();
  expect((await save).error).toBeInstanceOf(CommandWriteOutcomeUnknown);
});

it("a retired or failed thread keeps its slot until it has exited", async () => {
  const { lanes, threads, advance, open } = harness({ maxThreads: 1, spares: 1 });
  const a = await open("/a", () => threads[0]);
  lanes.close(a);
  threads[0]?.answer(0);
  await flush();
  advance(5000);
  // Told to exit when idle, but not gone yet: the cap still counts it.
  expect(threads[0]?.drained).toBe(true);
  expect(lanes.threads()).toBe(1);
  const waiting = settle(lanes.run("/b", { op: "openPath", path: "/b", handle: lanes.allocate() }));
  expect(threads).toHaveLength(1);
  threads[0]?.exit();
  expect(threads).toHaveLength(2);
  // An error makes a thread unusable, but only its exit frees the slot.
  threads[1]?.events.failed(new Error("boom"));
  expect(await waiting).toMatchObject({ error: { message: "boom" } });
  void settle(lanes.run("/c", { op: "openPath", path: "/c", handle: lanes.allocate() }));
  expect(threads).toHaveLength(2);
  threads[1]?.exit();
  expect(threads).toHaveLength(3);
});

it("once stuck threads fill the reserve, no thread starts for a mount under another name", async () => {
  const { lanes, threads, advance, open } = harness({
    maxWorkers: 2,
    maxThreads: 3,
    stuckPerRoot: 2,
  });
  const home = await open("/home", () => threads[0]);
  const share = await open("/mnt/share", () => threads[1]);
  void settle(lanes.run("/mnt/share", fstat(share)));
  advance(1000);
  // The same dead share reached by another path string gets no thread of its own.
  await expect(
    lanes.run("/Volumes/share", {
      op: "openPath",
      path: "/Volumes/share",
      handle: lanes.allocate(),
    }),
  ).rejects.toThrow("Too many command folders stopped responding");
  expect(threads).toHaveLength(2);
  // A root already holding a thread carries on.
  const stat = lanes.run("/home", fstat(home));
  threads[0]?.answer(0);
  await stat;
  // Once the stuck thread has returned and exited, there is room again.
  threads[1]?.exit();
  await open("/Volumes/share", () => threads[2]);
});

it("a root settles once its last draining thread has exited", async () => {
  const { lanes, threads, advance, open } = harness();
  await lanes.settled("/a");
  const a = await open("/a", () => threads[0]);
  void settle(lanes.run("/a", fstat(a)));
  advance(1000);
  let settled = false;
  void lanes.settled("/a").then(() => (settled = true));
  await flush();
  expect(settled).toBe(false);
  threads[0]?.exit();
  await flush();
  expect(settled).toBe(true);
});

it("an idle thread is lent to the next root, then drained after the idle period", async () => {
  const { lanes, threads, advance, open } = harness();
  const a = await open("/a", () => threads[0]);
  expect(threads[0]?.held).toBe(false);
  lanes.close(a);
  expect(threads[0]?.held).toBe(true);
  threads[0]?.answer(0);
  await flush();
  const b = await open("/b", () => threads[0]);
  expect(threads).toHaveLength(1);
  lanes.close(b);
  threads[0]?.answer(0);
  await flush();
  advance(5000);
  expect(threads[0]?.drained).toBe(true);
  await open("/c", () => threads[1]);
  expect(threads).toHaveLength(2);
});

it("a thread that crashes fails its root's calls, its handles die, and the next call starts a new one", async () => {
  const { lanes, threads, open } = harness();
  const a = await open("/a", () => threads[0]);
  const lost = settle(lanes.run("/a", fstat(a)));
  threads[0]?.exit();
  expect(await lost).toMatchObject({ error: { message: "Command discovery worker exited" } });
  await expect(lanes.run("/a", fstat(a))).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
  await open("/a", () => threads[1]);
});

it("many roots on one dead mount never start more threads than the cap", async () => {
  const { lanes, threads, advance } = harness({ maxWorkers: 3, maxThreads: 5 });
  const opens = Array.from({ length: 10 }, (_, i) =>
    settle(
      lanes.run(`/dead/${i}`, { op: "openPath", path: `/dead/${i}`, handle: lanes.allocate() }),
    ),
  );
  expect(threads).toHaveLength(3);
  // The first three stall and drain. One more thread starts while the stuck ones still leave
  // room in the reserve; once they fill it, no more start.
  advance(1000);
  expect(threads).toHaveLength(4);
  advance(1000);
  const results = await Promise.all(opens);
  expect(threads).toHaveLength(4);
  const messages = results.map((r) => (r.error instanceof Error ? r.error.message : ""));
  expect(messages.filter((m) => m === "Command folder stopped responding")).toHaveLength(4);
  expect(messages.filter((m) => m === "Too many command folders are busy")).toHaveLength(6);
  // A healthy root fails at once while the stuck threads fill the reserve; once enough of them
  // have returned it is served.
  const fresh = () => ({
    op: "openPath" as const,
    path: "/home/prompts",
    handle: lanes.allocate(),
  });
  await expect(lanes.run("/home/prompts", fresh())).rejects.toThrow("stopped responding");
  for (const thread of threads.slice(0, 3)) thread.exit();
  const healthy = lanes.run("/home/prompts", fresh());
  expect(threads).toHaveLength(5);
  threads[4]?.answer(0);
  await expect(healthy).resolves.toMatchObject({ value: 0 });
});

it("a root waiting for a thread takes the next one another root lets go", async () => {
  const { lanes, threads, open } = harness({ maxWorkers: 1, spares: 0 });
  const a = await open("/a", () => threads[0]);
  const waiting = lanes.run("/b", { op: "openPath", path: "/b", handle: lanes.allocate() });
  expect(threads).toHaveLength(1);
  lanes.close(a);
  threads[0]?.answer(0);
  expect(ops(threads[0]).at(-1)).toMatchObject({ op: "openPath", path: "/b" });
  threads[0]?.answer(0);
  await expect(waiting).resolves.toMatchObject({ value: 0 });
});
