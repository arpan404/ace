import { expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { devicesToolkit, connectDevices } from "./index.ts";
import {
  agent,
  bind,
  cleanups,
  deferred,
  delegate,
  deviceId,
  harness,
  human,
} from "./service-test-support.ts";

it("closing human logs preserves an agent's log stream", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "logs", deviceId, limit: 10 }, agent);
  await h.request({ op: "logs.start", deviceId });
  await h.request({ op: "logs.stop", deviceId });
  const received = deferred<void>();
  const lines: string[] = [];
  await h.service.subscribeLogs(deviceId, agent, async (batch) => {
    lines.push(...batch.lines);
    received.resolve();
  });
  h.log("agent still watching");
  await received.promise;
  expect(lines).toEqual(["agent still watching"]);
  await h.request({ op: "logs.stop", deviceId }, agent);
  await h.logExit();
});
it("deleted idle devices no thread uses release their session slots", async () => {
  const h = await harness();
  await h.request({ op: "enable", enabled: true });
  await h.request({ op: "controller", deviceId, controller: "none" });
  h.removeDevice();
  expect(await h.service.list()).toEqual([]);
  expect(h.service.states()).toEqual([]);
});
it("excess log readers are refused while existing readers can still stop cleanly", async () => {
  const h = await harness();
  await bind(h);
  const readers = Array.from({ length: 64 }, (_, index) => ({
    kind: "human" as const,
    owner: `reader-${index}`,
  }));
  for (const reader of readers) await h.request({ op: "logs.start", deviceId }, reader);
  await expect(h.request({ op: "logs.start", deviceId })).rejects.toThrow(
    "Too many device log readers",
  );
  for (const reader of readers) await h.request({ op: "logs.stop", deviceId }, reader);
  await h.logExit();
});

it("capture opening expires separately and terminates its stalled native process", async () => {
  const h = await harness(false, true);
  await bind(h);
  const gate = h.blockCapture();
  const rejected = expect(h.request({ op: "start", deviceId })).rejects.toMatchObject({
    code: "timeout",
    message: "The live view did not open",
  });
  try {
    await h.captureEntered.promise;
    h.time(30_000);
    h.deadlines();
    await rejected;
    expect((await h.nativeExit()).reason).toBe("stopped");
    expect(h.service.states()[0]).toMatchObject({ lifecycle: "failed" });
  } finally {
    gate.resolve();
  }
});

it("a failed agent log start does not retain the later human stream", async () => {
  const h = await harness();
  await bind(h);
  const logs = h.platform.logs.bind(h.platform);
  h.platform.logs = async () => {
    throw new Error("Fixture discovery failed");
  };
  await expect(h.request({ op: "logs", deviceId, limit: 10 }, agent)).rejects.toThrow(
    "Fixture discovery failed",
  );
  h.platform.logs = logs;
  await h.request({ op: "logs.start", deviceId });
  await h.request({ op: "logs.stop", deviceId });
  expect((await h.logExit()).reason).toBe("stopped");
});

it("a supported long agent typing request stays live for six minutes through MCP", async () => {
  const h = await harness();
  await delegate(h);
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const registry = new ToolRegistry({
    scheduler: {
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  devicesToolkit(h.service).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    {
      sessionId: "typing-session",
      threadId: ThreadId.parse("thread-1"),
      agentId: AgentId.parse("agent-1"),
      capabilities: ["devices"],
    },
    new AbortController().signal,
  );
  cleanups.push(async () => lease.end());
  const gate = h.blockInput();
  const installing = registry.call(
    "sim_act",
    { simId: deviceId, action: "type", text: "x".repeat(4096) },
    lease.principal,
    new AbortController().signal,
  );
  await h.entered.promise;
  now = 360000;
  h.time(now);
  h.deadlines();
  for (const timer of timers) if (timer.at <= now) timer.run();
  gate.resolve();
  expect(await installing).toMatchObject({
    content: [{ type: "text", text: '{"completed":true}' }],
  });
  expect(h.service.states()[0]?.controller).toBe("agent");
  expect(h.effects).toEqual(["-s emulator-5554 shell 'input' 'text' '" + "x".repeat(4096) + "'"]);
});

it.each(["disconnect", "stop"] as const)(
  "%s while log discovery is pending prevents a child starting",
  async (cancel) => {
    const h = await harness();
    await bind(h);
    const lookup = deferred<void>();
    const entered = deferred<void>();
    const logs = h.platform.logs.bind(h.platform);
    h.platform.logs = async (device) => {
      entered.resolve();
      await lookup.promise;
      return logs(device);
    };
    const started = h.request({ op: "logs.start", deviceId });
    const rejected = expect(started).rejects.toThrow();
    await entered.promise;
    if (cancel === "disconnect") h.service.disconnect(human.owner);
    else await h.request({ op: "logs.stop", deviceId });
    lookup.resolve();
    await rejected;
    expect(h.logStarted()).toBe(false);
  },
);

it("a cancelled older log lookup cannot remove a fresh reader or its shared stream", async () => {
  const h = await harness();
  await bind(h);
  const lookup = deferred<void>();
  const entered = deferred<void>();
  const logs = h.platform.logs.bind(h.platform);
  h.platform.logs = async (device) => {
    entered.resolve();
    await lookup.promise;
    return logs(device);
  };
  const old = h.request({ op: "logs.start", deviceId });
  const rejected = expect(old).rejects.toThrow();
  await entered.promise;
  await h.request({ op: "logs.stop", deviceId });
  h.platform.logs = logs;
  await h.request({ op: "logs.start", deviceId });
  await h.request({ op: "logs", deviceId, limit: 10 }, agent);
  lookup.resolve();
  await rejected;
  h.service.disconnect(agent.owner);
  const received = deferred<void>();
  const lines: string[] = [];
  const unsubscribe = await h.service.subscribeLogs(deviceId, human, async (batch) => {
    lines.push(...batch.lines);
    received.resolve();
  });
  h.log("fresh reader remains");
  await received.promise;
  expect(lines).toContain("fresh reader remains");
  unsubscribe();
  await h.request({ op: "logs.stop", deviceId });
  expect((await h.logExit()).reason).toBe("stopped");
});

it("revoking a device peer during log discovery cannot start an unauthorized process", async () => {
  const h = await harness();
  await bind(h);
  const lookup = deferred<void>();
  const entered = deferred<void>();
  const logs = h.platform.logs.bind(h.platform);
  h.platform.logs = async (device) => {
    entered.resolve();
    await lookup.promise;
    return logs(device);
  };
  let authorized = true;
  const channel = connectDevices(h.service, "revoked-reader", {
    authorize: () => authorized,
    canReadThread: () => true,
    agentExists: () => true,
    async send() {},
    async frame() {},
    async image() {},
  });
  try {
    const started = channel.request({
      type: "devices.request",
      requestId: "logs",
      operation: { op: "logs.start", deviceId },
    });
    await entered.promise;
    authorized = false;
    lookup.resolve();
    await started;
    expect(h.logStarted()).toBe(false);
  } finally {
    channel.close();
  }
});

it("stopping logs during first subscription discovery prevents startup and permits a fresh reader", async () => {
  const h = await harness();
  await h.request({ op: "enable", enabled: true });
  const inventory = h.blockInventory();
  const received = deferred<void>();
  const lines: string[] = [];
  const channel = connectDevices(h.service, "first-log-reader", {
    authorize: () => true,
    canReadThread: () => true,
    agentExists: () => true,
    async send(message) {
      if (message.type !== "devices.logs") return;
      lines.push(...message.lines);
      received.resolve();
    },
    async frame() {},
    async image() {},
  });
  const request = (requestId: string, op: "logs.start" | "logs.stop") =>
    channel.request({
      type: "devices.request",
      requestId,
      operation: { op, deviceId },
    });
  try {
    const old = request("old", "logs.start");
    await h.inventoryEntered.promise;
    const stopped = request("stop", "logs.stop");
    inventory.resolve();
    await Promise.all([old, stopped]);
    expect(h.logStarted()).toBe(false);
    await request("fresh", "logs.start");
    h.log("fresh subscription receives logs");
    h.deadlines(100);
    await received.promise;
    expect(lines).toContain("fresh subscription receives logs");
    await request("fresh-stop", "logs.stop");
    expect((await h.logExit()).reason).toBe("stopped");
  } finally {
    inventory.resolve();
    channel.close();
  }
});
