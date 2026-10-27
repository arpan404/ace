import { expect, it, vi } from "vitest";
import { MachineEntry } from "@ace/client/machines";
import {
  ProductionTransportError,
  createMachinesRuntime,
  failClosedRuntime,
  type MachineRuntime,
  type MachineRuntimeDirectory,
} from "./machines-runtime.ts";

function entry(hostId: string, deviceId = `phone-for-${hostId}`): MachineEntry {
  return MachineEntry.parse({
    hostId,
    displayName: hostId,
    target: { kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: "9f".repeat(32) },
    deviceId,
  });
}

class FakeRuntime implements MachineRuntime {
  started = 0;
  closed = 0;
  online: boolean[] = [];
  retries = 0;
  wakes = 0;
  failStart?: unknown;
  seen: MachineEntry[];
  constructor(seen: MachineEntry[]) {
    this.seen = seen;
  }
  async start(): Promise<void> {
    this.started += 1;
    if (this.failStart !== undefined) throw this.failStart;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  networkOnline(online: boolean): void {
    this.online.push(online);
  }
  reconnectNow(): void {
    this.retries += 1;
  }
  wake(): void {
    this.wakes += 1;
  }
}

function setup(initial: MachineEntry[], failStarts = new Map<string, unknown>()) {
  let current: MachineEntry[] = [...initial];
  const runtimes = new Map<string, FakeRuntime>();
  const seen: MachineEntry[] = [];
  const order: string[] = [];
  const directory: MachineRuntimeDirectory & { removed: string[]; failRemove?: unknown } = {
    removed: [],
    load: async () => [...current],
    remove: async (hostId: string) => {
      order.push(`directory.remove:${hostId}`);
      if (directory.failRemove !== undefined) throw directory.failRemove;
      directory.removed.push(hostId);
      current = current.filter((candidate) => candidate.hostId !== hostId);
    },
  };
  const manager = createMachinesRuntime({
    directory,
    makeRuntime: (candidate) => {
      seen.push(candidate);
      order.push(`make:${candidate.hostId}`);
      const runtime = new FakeRuntime(seen);
      const failStart = failStarts.get(candidate.hostId);
      if (failStart !== undefined) runtime.failStart = failStart;
      runtime.close = async () => {
        runtime.closed += 1;
        order.push(`close:${candidate.hostId}`);
      };
      runtimes.set(candidate.hostId, runtime);
      return runtime;
    },
    afterRemove: (hostId) => {
      order.push(`afterRemove:${hostId}`);
    },
  });
  return {
    manager,
    directory,
    runtimes,
    seen,
    order,
    relist(next: MachineEntry[]) {
      current = [...next];
    },
  };
}

it("connects every listed machine on its own isolated runtime", async () => {
  const { manager, seen, runtimes } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  expect(manager.entries().map((candidate) => candidate.hostId)).toEqual(["studio", "laptop"]);
  expect(seen.map((candidate) => candidate.hostId)).toEqual(["studio", "laptop"]);
  expect(seen[0]?.deviceId).toBe("phone-for-studio");
  expect(seen[1]?.deviceId).toBe("phone-for-laptop");
  expect(runtimes.get("studio")).not.toBe(runtimes.get("laptop"));
  expect(runtimes.get("studio")?.started).toBe(1);
  expect(runtimes.get("laptop")?.started).toBe(1);
  expect(manager.client("studio")).toBe(runtimes.get("studio"));
});

it("keeps a failed machine from closing the other one and records why", async () => {
  const failure = new Error("Keystore locked");
  const { manager, runtimes } = setup(
    [entry("studio"), entry("laptop")],
    new Map([["studio", failure]]),
  );
  await manager.load();
  expect(runtimes.get("laptop")?.started).toBe(1);
  expect(manager.client("studio")).toBeUndefined();
  expect(manager.failure("studio")).toBe(failure);
  expect(manager.failure("laptop")).toBeUndefined();
});

it("a refresh that changes nothing restarts nothing", async () => {
  const { manager, runtimes } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  const studio = runtimes.get("studio");
  await manager.refresh();
  expect(runtimes.get("studio")).toBe(studio);
  expect(studio?.started).toBe(1);
  expect(studio?.closed).toBe(0);
});

it("a rename keeps the runtime while a new target replaces it", async () => {
  const { manager, runtimes } = setup([entry("studio")]);
  await manager.load();
  const first = runtimes.get("studio");
  const renamed: MachineEntry = { ...entry("studio"), displayName: "Desk" };
  await manager.connectEntry(renamed);
  expect(runtimes.get("studio")).toBe(first);
  expect(first?.started).toBe(1);
  const moved: MachineEntry = {
    ...entry("studio"),
    target: { kind: "direct", url: "wss://10.0.0.9:4243/", fingerprint: "9f".repeat(32) },
  };
  await manager.connectEntry(moved);
  expect(first?.closed).toBe(1);
  expect(runtimes.get("studio")?.started).toBe(1);
  expect(manager.client("studio")).not.toBe(first);
});

it("a new device binding replaces the runtime, like a re-pair", async () => {
  const { manager, runtimes } = setup([entry("studio", "phone-1")]);
  await manager.load();
  const first = runtimes.get("studio");
  await manager.connectEntry(entry("studio", "phone-2"));
  expect(first?.closed).toBe(1);
  expect(manager.client("studio")).not.toBe(first);
});

it("overlapping replacements leave only the latest runtime attached", async () => {
  const { manager } = setup([entry("studio")]);
  await manager.load();
  const firstEpoch = manager.epochOf("studio");
  const moved: MachineEntry = {
    ...entry("studio"),
    target: { kind: "direct", url: "wss://10.0.0.9:4243/", fingerprint: "9f".repeat(32) },
  };
  const [first, second] = await Promise.all([
    manager.connectEntry(entry("studio")),
    manager.connectEntry(moved),
  ]);
  expect(first).not.toBe(second);
  expect(manager.client("studio")).toBe(second);
  expect(manager.isCurrent("studio", firstEpoch ?? -1)).toBe(false);
  expect(manager.isCurrent("studio", manager.epochOf("studio") ?? -1)).toBe(true);
});

it("removal stops the runtime before the directory entry goes, then detaches", async () => {
  const { manager, directory, order, runtimes } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  const studio = runtimes.get("studio");
  const epoch = manager.epochOf("studio");
  await manager.remove("studio");
  expect(order).toEqual([
    "make:studio",
    "make:laptop",
    "close:studio",
    "directory.remove:studio",
    "afterRemove:studio",
  ]);
  expect(directory.removed).toEqual(["studio"]);
  expect(studio?.closed).toBe(1);
  expect(manager.client("studio")).toBeUndefined();
  expect(manager.client("laptop")).toBe(runtimes.get("laptop"));
  expect(manager.isCurrent("studio", epoch ?? -1)).toBe(false);
  expect(runtimes.get("laptop")?.closed).toBe(0);
});

it("a failed directory removal reconnects the machine and rethrows", async () => {
  const { manager, directory, runtimes } = setup([entry("studio")]);
  await manager.load();
  const first = runtimes.get("studio");
  directory.failRemove = new Error("disk full");
  await expect(manager.remove("studio")).rejects.toThrow("disk full");
  expect(first?.closed).toBe(1);
  expect(manager.client("studio")).not.toBe(first);
  expect(runtimes.get("studio")?.started).toBe(1);
  expect(manager.entries().map((candidate) => candidate.hostId)).toEqual(["studio"]);
});

it("a dropped listing stops only that runtime; late callbacks stay stale", async () => {
  const { manager, runtimes, relist } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  const studio = runtimes.get("studio");
  const epoch = manager.epochOf("studio");
  relist([entry("laptop")]);
  await manager.refresh();
  expect(studio?.closed).toBe(1);
  expect(runtimes.get("laptop")?.closed).toBe(0);
  expect(manager.isCurrent("studio", epoch ?? -1)).toBe(false);
});

it("a directory failure keeps every running runtime", async () => {
  const { manager, directory, runtimes } = setup([entry("studio")]);
  await manager.load();
  const failing = directory.load;
  directory.load = async () => {
    await failing();
    throw new Error("storage unavailable");
  };
  await expect(manager.refresh()).rejects.toThrow("storage unavailable");
  expect(manager.client("studio")).toBe(runtimes.get("studio"));
  expect(runtimes.get("studio")?.closed).toBe(0);
});

it("disconnectAll stops every runtime and invalidates their callbacks", async () => {
  const { manager, runtimes } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  const studioEpoch = manager.epochOf("studio");
  const laptopEpoch = manager.epochOf("laptop");
  await manager.disconnectAll();
  expect(runtimes.get("studio")?.closed).toBe(1);
  expect(runtimes.get("laptop")?.closed).toBe(1);
  expect(manager.client("studio")).toBeUndefined();
  expect(manager.isCurrent("studio", studioEpoch ?? -1)).toBe(false);
  expect(manager.isCurrent("laptop", laptopEpoch ?? -1)).toBe(false);
});

it("fans connectivity and wake out to every live runtime", async () => {
  const { manager, runtimes } = setup([entry("studio"), entry("laptop")]);
  await manager.load();
  manager.setOnline(false);
  manager.setOnline(true, true);
  manager.wake();
  for (const hostId of ["studio", "laptop"]) {
    expect(runtimes.get(hostId)?.online).toEqual([false, true]);
    expect(runtimes.get(hostId)?.retries).toBe(1);
    expect(runtimes.get(hostId)?.wakes).toBe(1);
  }
});

it("stays fail-closed without a pinned transport", () => {
  expect(() => failClosedRuntime(entry("studio"))).toThrow(ProductionTransportError);
  expect(() => failClosedRuntime(entry("studio"))).toThrow(/pinned native transport/);
  const hooks = { beforeConnect: vi.fn() };
  const manager = createMachinesRuntime({
    directory: {
      load: async () => [entry("studio")],
      remove: async () => {},
    },
    makeRuntime: failClosedRuntime,
    beforeConnect: hooks.beforeConnect,
  });
  return expect(manager.load())
    .resolves.toEqual([entry("studio")])
    .then(() => {
      expect(manager.client("studio")).toBeUndefined();
      expect(manager.failure("studio")).toBeInstanceOf(ProductionTransportError);
      expect(hooks.beforeConnect).not.toHaveBeenCalled();
    });
});

class CloseableRuntime implements MachineRuntime {
  started = 0;
  closed = 0;
  online: boolean[] = [];
  retries = 0;
  wakes = 0;
  failStart?: unknown;
  failClose?: unknown;
  throwOnline = false;
  throwRetry = false;
  throwWake = false;
  binding: MachineEntry;
  constructor(binding: MachineEntry) {
    this.binding = binding;
  }
  async start(): Promise<void> {
    this.started += 1;
    if (this.failStart !== undefined) throw this.failStart;
  }
  async close(): Promise<void> {
    this.closed += 1;
    if (this.failClose !== undefined) throw this.failClose;
  }
  networkOnline(online: boolean): void {
    if (this.throwOnline) throw new Error(`online broken for ${this.binding.hostId}`);
    this.online.push(online);
  }
  reconnectNow(): void {
    if (this.throwRetry) throw new Error(`retry broken for ${this.binding.hostId}`);
    this.retries += 1;
  }
  wake(): void {
    if (this.throwWake) throw new Error(`wake broken for ${this.binding.hostId}`);
    this.wakes += 1;
  }
}

function setupLifecycle(initial: MachineEntry[]) {
  let current: MachineEntry[] = [...initial];
  const runtimes: CloseableRuntime[] = [];
  const byHost = new Map<string, CloseableRuntime[]>();
  const failStart = new Map<string, unknown>();
  const failClose = new Map<string, unknown>();
  let failRemove: unknown;
  const removed: string[] = [];
  const directory: MachineRuntimeDirectory = {
    load: async () => [...current],
    remove: async (hostId: string) => {
      if (failRemove !== undefined) throw failRemove;
      removed.push(hostId);
      current = current.filter((candidate) => candidate.hostId !== hostId);
    },
  };
  const manager = createMachinesRuntime({
    directory,
    makeRuntime: (candidate) => {
      const runtime = new CloseableRuntime(candidate);
      const start = failStart.get(startKey(candidate)) ?? failStart.get(candidate.hostId);
      if (start !== undefined) runtime.failStart = start;
      const close = failClose.get(candidate.hostId);
      if (close !== undefined) runtime.failClose = close;
      runtimes.push(runtime);
      const list = byHost.get(candidate.hostId) ?? [];
      list.push(runtime);
      byHost.set(candidate.hostId, list);
      return runtime;
    },
  });
  return {
    manager,
    directory,
    runtimes,
    byHost,
    removed,
    relist(next: MachineEntry[]) {
      current = [...next];
    },
    setFailRemove(error: unknown) {
      failRemove = error;
    },
    setFailStart(hostId: string, error: unknown, targetUrl?: string) {
      failStart.set(targetUrl === undefined ? hostId : `${hostId}|direct|${targetUrl}`, error);
      for (const runtime of byHost.get(hostId) ?? []) {
        if (targetUrl === undefined || runtime.binding.target.url === targetUrl) {
          runtime.failStart = error;
        }
      }
    },
    setFailClose(hostId: string, error: unknown) {
      failClose.set(hostId, error);
      for (const runtime of byHost.get(hostId) ?? []) {
        runtime.failClose = error;
      }
    },
    clearFailClose(hostId: string) {
      failClose.delete(hostId);
      for (const runtime of byHost.get(hostId) ?? []) {
        runtime.failClose = undefined;
      }
    },
    live(hostId: string): CloseableRuntime[] {
      return byHost.get(hostId) ?? [];
    },
  };
}

function movedEntry(hostId: string): MachineEntry {
  return {
    ...entry(hostId),
    target: { kind: "direct", url: "wss://10.0.0.9:4243/", fingerprint: "9f".repeat(32) },
  };
}

function startKey(candidate: MachineEntry): string {
  return `${candidate.hostId}|${candidate.target.kind}|${candidate.target.url}`;
}

it("a failed replacement close keeps the old runtime attached without a duplicate", async () => {
  const { manager, live, setFailClose } = setupLifecycle([entry("studio")]);
  await manager.load();
  const old = manager.client("studio");
  const epoch = manager.epochOf("studio");
  const closeError = new Error("close busy");
  setFailClose("studio", closeError);
  await expect(manager.connectEntry(movedEntry("studio"))).rejects.toBe(closeError);
  expect(manager.client("studio")).toBe(old);
  expect(live("studio")).toHaveLength(1);
  expect(manager.failure("studio")).toBe(closeError);
  expect(manager.epochOf("studio")).toBe(epoch);
  expect(manager.isCurrent("studio", epoch ?? -1)).toBe(true);
});

it("a failed removal close keeps the runtime and never touches the directory", async () => {
  const { manager, removed, live, setFailClose } = setupLifecycle([entry("studio")]);
  await manager.load();
  const old = manager.client("studio");
  const epoch = manager.epochOf("studio");
  const closeError = new Error("close busy");
  setFailClose("studio", closeError);
  await expect(manager.remove("studio")).rejects.toBe(closeError);
  expect(manager.client("studio")).toBe(old);
  expect(removed).toEqual([]);
  expect(manager.entries().map((candidate) => candidate.hostId)).toEqual(["studio"]);
  expect(manager.isCurrent("studio", epoch ?? -1)).toBe(true);
  expect(live("studio")).toHaveLength(1);
});

it("a failed disconnect keeps the runtime attached", async () => {
  const { manager, live, setFailClose, clearFailClose } = setupLifecycle([entry("studio")]);
  await manager.load();
  const old = manager.client("studio");
  const closeError = new Error("close busy");
  setFailClose("studio", closeError);
  await expect(manager.disconnect("studio")).rejects.toBe(closeError);
  expect(manager.client("studio")).toBe(old);
  expect(live("studio")).toHaveLength(1);
  clearFailClose("studio");
  await manager.disconnect("studio");
  expect(manager.client("studio")).toBeUndefined();
});

it("a failed replacement start re-opens the previous binding instead of dropping the machine", async () => {
  const { manager, live, setFailStart } = setupLifecycle([entry("studio")]);
  await manager.load();
  const first = manager.client("studio");
  const startError = new Error("new target refused");
  setFailStart("studio", startError, "wss://10.0.0.9:4243/");
  await expect(manager.connectEntry(movedEntry("studio"))).rejects.toBe(startError);
  const rolledBack = manager.client("studio");
  expect(rolledBack).toBeDefined();
  expect(rolledBack).not.toBe(first);
  expect((rolledBack as CloseableRuntime).binding.target).toEqual(entry("studio").target);
  expect((rolledBack as CloseableRuntime).started).toBe(1);
  expect(manager.failure("studio")).toBe(startError);
  expect(live("studio")).toHaveLength(3);
});

it("a failed replacement build re-opens the previous binding", async () => {
  let calls = 0;
  const directory: MachineRuntimeDirectory = {
    load: async () => [entry("studio")],
    remove: async () => {},
  };
  const seen: MachineEntry[] = [];
  const manager = createMachinesRuntime({
    directory,
    makeRuntime: (candidate) => {
      calls += 1;
      if (calls === 1) {
        const runtime = new CloseableRuntime(candidate);
        seen.push(candidate);
        return runtime;
      }
      if (candidate.target.url === movedEntry("studio").target.url) {
        throw new Error("no transport for new target");
      }
      const runtime = new CloseableRuntime(candidate);
      seen.push(candidate);
      return runtime;
    },
  });
  await manager.load();
  const first = manager.client("studio");
  await expect(manager.connectEntry(movedEntry("studio"))).rejects.toThrow(
    "no transport for new target",
  );
  expect(manager.client("studio")).toBeDefined();
  expect(manager.client("studio")).not.toBe(first);
  expect(seen).toHaveLength(2);
});

it("a failed directory removal still throws the directory error when the reconnect also fails", async () => {
  const { manager, setFailRemove, setFailStart } = setupLifecycle([entry("studio")]);
  await manager.load();
  setFailRemove(new Error("disk full"));
  setFailStart("studio", new Error("reconnect refused"), "wss://100.64.0.7:4243/");
  await expect(manager.remove("studio")).rejects.toThrow("disk full");
  expect(manager.failure("studio")).toEqual(new Error("reconnect refused"));
  expect(manager.entries().map((candidate) => candidate.hostId)).toEqual(["studio"]);
});

it("one broken runtime never blocks connectivity or wake fan-out", async () => {
  const { manager, live } = setupLifecycle([entry("studio"), entry("laptop")]);
  await manager.load();
  const [studio] = live("studio");
  const [laptop] = live("laptop");
  studio!.throwOnline = true;
  studio!.throwWake = true;
  expect(() => manager.setOnline(false)).not.toThrow();
  expect(() => manager.wake()).not.toThrow();
  expect(laptop!.online).toEqual([false]);
  expect(laptop!.wakes).toBe(1);
  expect(studio!.online).toEqual([]);
  studio!.throwOnline = false;
  studio!.throwRetry = true;
  expect(() => manager.setOnline(true, true)).not.toThrow();
  expect(laptop!.online).toEqual([false, true]);
  expect(laptop!.retries).toBe(1);
});

it("epochs are never reused, so stale callbacks cannot become current again", async () => {
  const { manager } = setupLifecycle([entry("studio")]);
  await manager.load();
  const firstEpoch = manager.epochOf("studio") ?? -1;
  await manager.remove("studio");
  expect(manager.epochOf("studio")).toBeUndefined();
  expect(manager.isCurrent("studio", firstEpoch)).toBe(false);
  await manager.connectEntry(entry("studio"));
  const secondEpoch = manager.epochOf("studio") ?? -1;
  expect(secondEpoch).toBeGreaterThan(firstEpoch);
  expect(manager.isCurrent("studio", firstEpoch)).toBe(false);
  expect(manager.isCurrent("studio", secondEpoch)).toBe(true);
  await manager.disconnect("studio");
  expect(manager.isCurrent("studio", secondEpoch)).toBe(false);
  await manager.connectEntry(entry("studio"));
  expect(manager.epochOf("studio") ?? -1).toBeGreaterThan(secondEpoch);
});

it("disconnectAll keeps runtimes that fail to close and reports them together", async () => {
  const { manager, live, setFailClose } = setupLifecycle([entry("studio"), entry("laptop")]);
  await manager.load();
  const studio = manager.client("studio");
  const closeError = new Error("studio close busy");
  setFailClose("studio", closeError);
  await expect(manager.disconnectAll()).rejects.toBeInstanceOf(AggregateError);
  expect(manager.client("studio")).toBe(studio);
  expect(manager.client("laptop")).toBeUndefined();
  expect(manager.failure("studio")).toBe(closeError);
  expect(live("laptop")).toHaveLength(1);
});

it("a reconcile close failure keeps that runtime while the other machines reconcile", async () => {
  const { manager, live, relist, setFailClose } = setupLifecycle([
    entry("studio"),
    entry("laptop"),
  ]);
  await manager.load();
  const studio = manager.client("studio");
  const epoch = manager.epochOf("studio");
  const closeError = new Error("studio close busy");
  setFailClose("studio", closeError);
  relist([entry("laptop")]);
  await expect(manager.refresh()).resolves.toEqual([entry("laptop")]);
  expect(manager.client("studio")).toBe(studio);
  expect(manager.client("laptop")).toBeDefined();
  expect(manager.failure("studio")).toBe(closeError);
  expect(manager.isCurrent("studio", epoch ?? -1)).toBe(true);
  expect(live("studio")).toHaveLength(1);
});
