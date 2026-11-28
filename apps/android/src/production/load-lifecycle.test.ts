import { expect, it, vi } from "vitest";
import { MachineEntry } from "@ace/client/machines";
import { createMachinesRuntime, type MachineRuntime } from "../runtime/machines-runtime.ts";
import { createLoadLifecycle } from "./load-lifecycle.ts";
import { withLoadTimeout } from "./load-timeout.ts";

function entry(hostId: string): MachineEntry {
  return MachineEntry.parse({
    hostId,
    displayName: hostId,
    target: { kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: "9f".repeat(32) },
    deviceId: `phone-for-${hostId}`,
  });
}

class FakeRuntime implements MachineRuntime {
  started = 0;
  closed = 0;
  binding: MachineEntry;
  constructor(binding: MachineEntry) {
    this.binding = binding;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  networkOnline(): void {}
  reconnectNow(): void {}
}

/** Deferred directory gate: real manager load blocks until the test releases it. */
function deferredDirectory(initial: MachineEntry[]) {
  let current = [...initial];
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    directory: {
      load: async () => {
        calls += 1;
        await gate;
        return [...current];
      },
      remove: async () => {},
    },
    get calls() {
      return calls;
    },
    relist(next: MachineEntry[]) {
      current = [...next];
    },
    release,
  };
}

it("a stale retry generation never disconnects the newer runtime (real manager)", async () => {
  const dir = deferredDirectory([entry("studio")]);
  const runtimes: FakeRuntime[] = [];
  const manager = createMachinesRuntime({
    directory: dir.directory,
    makeRuntime: (candidate) => {
      const runtime = new FakeRuntime(candidate);
      runtimes.push(runtime);
      return runtime;
    },
  });
  const owner = createLoadLifecycle();

  // First attempt starts and blocks inside directory.load.
  const staleId = owner.begin();
  const staleRaw = manager.load();
  owner.track(staleRaw);
  const staleSettled = staleRaw.then(
    () => "resolved",
    () => "rejected",
  );
  // Let the first load reach the gate.
  await Promise.resolve();
  await Promise.resolve();

  // Retry claims the newer generation while the orphan still runs. The retry
  // shares the same manager, so it queues behind the orphan via serialize.
  const currentId = owner.begin();
  const currentRaw = manager.load();
  owner.track(currentRaw);

  // Orphan settles late: only the current generation may adopt it, and the
  // stale path must never disconnect the shared manager.
  dir.release();
  const [staleEntries, currentEntries] = await Promise.all([staleRaw, currentRaw]);
  expect(staleEntries.map((candidate) => candidate.hostId)).toEqual(["studio"]);
  expect(currentEntries.map((candidate) => candidate.hostId)).toEqual(["studio"]);

  const applied: string[] = [];
  if (owner.isCurrent(staleId)) applied.push("stale");
  if (owner.isCurrent(currentId)) applied.push(...currentEntries.map((e) => e.hostId));
  expect(applied).toEqual(["studio"]);
  expect(owner.isCurrent(staleId)).toBe(false);

  // Stale cleanup path: no disconnectAll must run for a retry.
  // (Proved by the live runtime still attached with exactly one owner.)
  expect(manager.client("studio")).toBe(runtimes[0]);
  expect(runtimes).toHaveLength(1);
  expect(runtimes[0]?.closed).toBe(0);
  await staleSettled;
});

it("a stale load failure never surfaces over the newer generation (real manager)", async () => {
  let failNext = true;
  const manager = createMachinesRuntime({
    directory: {
      load: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("late offline");
        }
        return [entry("studio")];
      },
      remove: async () => {},
    },
    makeRuntime: (candidate) => new FakeRuntime(candidate),
  });
  const owner = createLoadLifecycle();
  const surfaced: string[] = [];

  const staleId = owner.begin();
  const staleRaw = manager.load();
  owner.track(staleRaw);
  const staleOutcome = staleRaw.then(
    () => "ok",
    (error: unknown) => {
      if (!owner.isCurrent(staleId)) return "stale-swallowed";
      surfaced.push(String(error));
      return "surfaced";
    },
  );

  owner.begin();
  const currentRaw = manager.load();
  owner.track(currentRaw);
  await currentRaw;
  expect(await staleOutcome).toBe("stale-swallowed");
  expect(surfaced).toEqual([]);
  expect(manager.client("studio")).toBeDefined();
});

it("terminal disposal drains late orphans then disconnects with no leak (real manager)", async () => {
  // The orphan blocks in pre-serialize work (grants/database analog): it has
  // not reached manager.load yet when disposal happens, so a naive
  // disconnect-now would be followed by the orphan opening runtimes after
  // cleanup. Draining first closes what the orphan opened.
  let releaseOrphan!: () => void;
  const orphanGate = new Promise<void>((resolve) => {
    releaseOrphan = resolve;
  });
  const runtimes: FakeRuntime[] = [];
  const manager = createMachinesRuntime({
    directory: {
      load: async () => [entry("studio")],
      remove: async () => {},
    },
    makeRuntime: (candidate) => {
      const runtime = new FakeRuntime(candidate);
      runtimes.push(runtime);
      return runtime;
    },
  });
  const owner = createLoadLifecycle();

  const generation = owner.begin();
  void generation;
  const raw = (async () => {
    await orphanGate;
    return manager.load();
  })();
  owner.track(raw);
  const timed = withLoadTimeout(raw, 10);
  await expect(timed).rejects.toThrow();

  // Unmount while the orphan still runs: invalidate, drain, disconnect last.
  const pending = owner.dispose();
  expect(owner.isDisposed()).toBe(true);
  releaseOrphan();
  await Promise.allSettled(pending);
  await manager.disconnectAll();

  expect(manager.client("studio")).toBeUndefined();
  expect(runtimes).toHaveLength(1);
  expect(runtimes[0]?.started).toBe(1);
  expect(runtimes[0]?.closed).toBe(1);
});

it("overlapping manager loads serialize with a single owner (real manager)", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = createMachinesRuntime({
    directory: {
      load: async () => {
        order.push("directory.load");
        await gate;
        return [entry("studio")];
      },
      remove: async () => {},
    },
    makeRuntime: (candidate) => {
      order.push(`make:${candidate.hostId}`);
      return new FakeRuntime(candidate);
    },
  });
  const first = manager.load();
  const second = manager.load();
  // Both queue through the manager's tail: the first directory read starts on
  // a microtask while the second waits behind it.
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["directory.load"]);
  release();
  await Promise.all([first, second]);
  expect(order.filter((line) => line === "directory.load")).toHaveLength(2);
  expect(manager.client("studio")).toBeDefined();
  expect(order.filter((line) => line === "make:studio")).toHaveLength(1);
});

it("dispose invalidates every generation and reports pending for the drain", async () => {
  const owner = createLoadLifecycle();
  const first = owner.begin();
  let release!: (value: string) => void;
  const work = new Promise<string>((resolve) => {
    release = resolve;
  });
  owner.track(work);
  const second = owner.begin();
  expect(owner.isCurrent(first)).toBe(false);
  expect(owner.isCurrent(second)).toBe(true);
  const pending = owner.dispose();
  expect(owner.isDisposed()).toBe(true);
  expect(owner.isCurrent(second)).toBe(false);
  expect(pending).toHaveLength(1);
  release("done");
  await expect(work).resolves.toBe("done");
  const settled = vi.fn();
  await Promise.allSettled(pending).then(settled);
  expect(settled).toHaveBeenCalledTimes(1);
});
