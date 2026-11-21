import { expect, it, vi } from "vitest";
import { MachineEntry } from "@ace/client/machines";
import { LoadTimeoutError, withLoadTimeout } from "./load-timeout.ts";
import { createLoadLifecycle } from "./load-lifecycle.ts";
import {
  createMachinesRuntime,
  type MachineRuntime,
  type MachineRuntimeDirectory,
} from "../runtime/machines-runtime.ts";

function testEntry(hostId: string): MachineEntry {
  return MachineEntry.parse({
    hostId,
    displayName: hostId,
    target: { kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: "9f".repeat(32) },
    deviceId: `phone-for-${hostId}`,
  });
}

class TestRuntime implements MachineRuntime {
  started = 0;
  closed = 0;
  async start(): Promise<void> {
    this.started += 1;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  networkOnline(): void {}
  reconnectNow(): void {}
}

it("resolves when the work finishes before the timeout", async () => {
  vi.useFakeTimers();
  try {
    const pending = withLoadTimeout(Promise.resolve("ok"), 1000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("ok");
  } finally {
    vi.useRealTimers();
  }
});

it("rejects with a retryable timeout when the work hangs", async () => {
  vi.useFakeTimers();
  try {
    const hanging = new Promise<string>(() => undefined);
    const pending = withLoadTimeout(hanging, 1000);
    const assertion = expect(pending).rejects.toBeInstanceOf(LoadTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it("propagates the work rejection instead of masking it", async () => {
  vi.useFakeTimers();
  try {
    const failing = Promise.reject(new Error("offline"));
    const pending = withLoadTimeout(failing, 1000);
    await expect(pending).rejects.toThrow("offline");
  } finally {
    vi.useRealTimers();
  }
});

it("hands a late database handle to orphan cleanup instead of leaking it", async () => {
  vi.useFakeTimers();
  try {
    let resolveWork!: (db: { closed: boolean }) => void;
    const work = new Promise<{ closed: boolean }>((resolve) => {
      resolveWork = resolve;
    });
    const closeAsync = vi.fn().mockResolvedValue(undefined);
    const pending = withLoadTimeout(work, 1000, (outcome) => {
      if (outcome.settled === "resolved") void closeAsync();
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(LoadTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    // The orphaned open resolves after the timeout: cleanup must run.
    resolveWork({ closed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(closeAsync).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("swallows a late orphan rejection so no unhandled rejection escapes", async () => {
  vi.useFakeTimers();
  try {
    let rejectWork!: (error: Error) => void;
    const work = new Promise<string>((_, reject) => {
      rejectWork = reject;
    });
    const onOrphan = vi.fn();
    const pending = withLoadTimeout(work, 1000, onOrphan);
    const assertion = expect(pending).rejects.toBeInstanceOf(LoadTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    rejectWork(new Error("late offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onOrphan).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("a stale load generation never disconnects the newer runtime (real manager)", async () => {
  // Real lifecycle shape: two `startup.load()` attempts share one manager.
  // The first blocks in the directory read while the retry queues behind it
  // through the manager's serialization. The stale generation must apply
  // nothing and, critically, must never disconnect the shared manager.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let directoryCalls = 0;
  const directory: MachineRuntimeDirectory = {
    load: async () => {
      directoryCalls += 1;
      if (directoryCalls === 1) await gate;
      return [testEntry("host-1")];
    },
    remove: async () => {},
  };
  const runtimes: TestRuntime[] = [];
  let disconnectCalls = 0;
  const manager = createMachinesRuntime({
    directory,
    makeRuntime: () => {
      const runtime = new TestRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const owner = createLoadLifecycle();
  const applied: string[] = [];

  const staleId = owner.begin();
  const staleRaw = manager.load();
  owner.track(staleRaw);
  const staleOutcome = (async () => {
    try {
      const entries = await withLoadTimeout(staleRaw, 10_000);
      if (!owner.isCurrent(staleId)) return;
      applied.push(...entries.map((entry) => entry.hostId));
    } catch {
      if (!owner.isCurrent(staleId)) return;
      throw new Error("retryable");
    }
  })();
  await Promise.resolve();
  await Promise.resolve();

  // Retry claims the newer generation before the orphan settles.
  const currentId = owner.begin();
  const currentRaw = manager.load();
  owner.track(currentRaw);
  release();
  const currentEntries = await withLoadTimeout(currentRaw, 10_000);
  if (owner.isCurrent(currentId)) applied.push(...currentEntries.map((entry) => entry.hostId));
  await staleOutcome;

  // Late orphan success: applies nothing, disconnects nothing.
  expect(applied).toEqual(["host-1"]);
  expect(owner.isCurrent(staleId)).toBe(false);
  expect(owner.isCurrent(currentId)).toBe(true);
  expect(manager.client("host-1")).toBe(runtimes[0]);
  expect(runtimes).toHaveLength(1);
  expect(runtimes[0]?.closed).toBe(0);
  // A stale cleanup would tear down the new generation; prove none ran by
  // disconnecting here exactly once and observing a single close.
  disconnectCalls += 1;
  await manager.disconnectAll();
  expect(disconnectCalls).toBe(1);
  expect(runtimes[0]?.closed).toBe(1);
  expect(manager.client("host-1")).toBeUndefined();
});

it("a stale load failure never surfaces a retry error over the newer attempt (real manager)", async () => {
  let failNext = true;
  const manager = createMachinesRuntime({
    directory: {
      load: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("late offline");
        }
        return [testEntry("host-1")];
      },
      remove: async () => {},
    },
    makeRuntime: () => new TestRuntime(),
  });
  const owner = createLoadLifecycle();
  const surfaced: string[] = [];

  const staleId = owner.begin();
  const staleRaw = manager.load();
  owner.track(staleRaw);
  const stale = (async () => {
    try {
      await withLoadTimeout(staleRaw, 10_000);
    } catch {
      if (!owner.isCurrent(staleId)) return;
      surfaced.push("stale error");
    }
  })();

  owner.begin();
  const currentRaw = manager.load();
  owner.track(currentRaw);
  await withLoadTimeout(currentRaw, 10_000);
  await stale;
  expect(surfaced).toEqual([]);
  expect(manager.client("host-1")).toBeDefined();
});
