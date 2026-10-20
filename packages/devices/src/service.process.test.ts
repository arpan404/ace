import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import type { DeviceInput } from "@ace/protocol/devices";
import { devicesToolkit, agentOwner, connectDevices } from "./index.ts";
import { decodeStreamMessage, StreamAssembler } from "@ace/browser/stream";
import {
  agent,
  bind,
  cleanups,
  deferred,
  delegate,
  delegateTo,
  deviceId,
  harness,
  human,
} from "./service-test-support.ts";
describe("in-app device ownership", () => {
  it("agents cannot turn devices on or hand out control", async () => {
    const h = await harness();
    await expect(h.request({ op: "enable", enabled: true }, agent)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await h.request({ op: "enable", enabled: true });
    await expect(
      h.request(
        {
          op: "controller",
          deviceId,
          controller: "agent",
          threadId: "thread-1",
          agentId: "agent-1",
        },
        agent,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(h.effects).toEqual([]);
  });
  it("a delegated device still rejects a different agent or thread", async () => {
    const h = await harness();
    await delegate(h);
    expect(h.service.states()[0]).toMatchObject({
      controller: "agent",
      holder: { threadId: "thread-1", agentId: "agent-1" },
    });
    const input: DeviceInput = { kind: "tap", x: 5, y: 10 };
    await h.request({ op: "input", deviceId, input }, agent);
    expect(h.effects[0]).toContain("'tap' '5' '10'");
    await expect(
      h.request(
        { op: "input", deviceId, input },
        { ...agent, owner: agentOwner("thread-1", "agent-2"), agentId: "agent-2" },
      ),
    ).rejects.toMatchObject({ code: "lease_required" });
    await expect(
      h.request({ op: "input", deviceId, input }, { ...agent, threadId: "thread-2" }),
    ).rejects.toMatchObject({ code: "lease_required" });
    expect(h.effects).toHaveLength(1);
  });
  it("human takeover invalidates queued agent input while the active command settles", async () => {
    const h = await harness();
    await delegate(h);
    const gate = h.blockInput();
    const first = h.request({ op: "input", deviceId, input: { kind: "tap", x: 1, y: 1 } }, agent);
    const firstRejected = expect(first).rejects.toMatchObject({ code: "lease_required" });
    await h.entered.promise;
    const second = h.request({ op: "input", deviceId, input: { kind: "tap", x: 2, y: 2 } }, agent);
    const secondRejected = expect(second).rejects.toMatchObject({ code: "lease_required" });
    await h.request({ op: "controller", deviceId, controller: "human" });
    gate.resolve();
    await firstRejected;
    await secondRejected;
    expect(h.effects).toHaveLength(1);
    expect(h.service.states()[0]?.controller).toBe("human");
  });
  it("an agent resumes after a thinking pause, while a disconnected human cannot inject input", async () => {
    const h = await harness();
    await delegate(h);
    h.time(30001);
    await h.request({ op: "input", deviceId, input: { kind: "key", key: "home" } }, agent);
    await h.request({ op: "controller", deviceId, controller: "human" });
    h.service.disconnect(human.owner);
    await expect(
      h.request({ op: "input", deviceId, input: { kind: "key", key: "home" } }),
    ).rejects.toMatchObject({ code: "lease_required" });
    expect(h.effects).toHaveLength(1);
  });
  it("a human can release a delegated agent without first taking control", async () => {
    const h = await harness();
    await delegate(h);
    await h.request({ op: "controller", deviceId, controller: "none" });
    await expect(
      h.request({ op: "input", deviceId, input: { kind: "tap", x: 1, y: 2 } }, agent),
    ).rejects.toMatchObject({ code: "lease_required" });
    expect(h.effects).toEqual([]);
    expect(h.service.states()[0]?.controller).toBe("none");
  });
  for (const observed of [false, true])
    it(`a disconnected agent needs fresh delegation after reconnecting ${observed ? "after" : "before"} an expiry update`, async () => {
      const h = await harness();
      await delegate(h);
      h.time(30001);
      if (observed) expect(h.service.states()[0]?.controller).toBe("none");
      h.service.disconnect(agent.owner);
      const reconnected = { ...agent };
      const input = { op: "input", deviceId, input: { kind: "tap", x: 1, y: 2 } };
      await expect(h.request(input, reconnected)).rejects.toMatchObject({ code: "lease_required" });
      expect(h.effects).toEqual([]);
      await delegate(h);
      await h.request(input, reconnected);
      expect(h.effects).toEqual([expect.stringContaining("'tap' '1' '2'")]);
    });
  it("disconnecting another owner preserves an agent's expired delegation", async () => {
    const h = await harness();
    await delegate(h);
    h.time(30001);
    h.service.disconnect("unrelated-owner");
    await h.request({ op: "input", deviceId, input: { kind: "key", key: "home" } }, agent);
    expect(h.effects).toEqual([expect.stringContaining("'keyevent' '3'")]);
    expect(h.service.states()[0]?.controller).toBe("agent");
  });
  it("slow viewers skip intermediate frames while another viewer receives the latest frame", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    const started = deferred<void>();
    const gate = deferred<void>();
    const drained = deferred<void>();
    const slow: number[] = [];
    const fast: number[] = [];
    await h.service.subscribe(deviceId, human, async (image) => {
      slow.push(image.header.sequence);
      if (image.header.sequence === 0) {
        started.resolve();
        await gate.promise;
      } else drained.resolve();
    });
    await started.promise;
    const fastDone = deferred<void>();
    await h.service.subscribe(deviceId, human, async (image) => {
      fast.push(image.header.sequence);
      if (image.header.sequence === 20) fastDone.resolve();
    });
    for (let i = 1; i <= 20; i++) h.publish(i);
    await fastDone.promise;
    gate.resolve();
    await drained.promise;
    expect(slow).toEqual([0, 20]);
    expect(fast.at(-1)).toBe(20);
  });
  it("recording publishes the actual stored screen packets and opaque metadata", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    await h.request({ op: "record.start", deviceId });
    h.publish(1);
    const result = await h.request({ op: "record.stop", deviceId });
    const artifact = h.publications[0];
    if (!artifact) throw new Error("No recording publication");
    const bytes = await readFile(artifact.path);
    expect(bytes.includes(Buffer.from("jpeg-0"))).toBe(true);
    expect(bytes.length).toBe(artifact.bytes);
    expect(result).toEqual({ id: artifact.id, bytes: artifact.bytes, mimeType: artifact.mimeType });
  });
  it("recording enforces its byte cap and downloads the registered bytes through the artifact API", async () => {
    const h = await harness(true);
    await bind(h);
    await h.request({ op: "start", deviceId });
    await h.request({ op: "record.start", deviceId });
    h.publish(1, 600);
    const result = await h.request({ op: "record.stop", deviceId });
    const meta = await import("zod").then(({ z }) =>
      z.object({ id: z.string(), bytes: z.number() }).parse(result),
    );
    const stored = h.publications[0];
    if (!stored || !h.files) throw new Error("Artifact not registered");
    expect(stored.bytes).toBeGreaterThan(0);
    expect(stored.bytes).toBeLessThanOrEqual(512);
    const download = await h.files.download("reader", {
      op: "artifact.download",
      artifactId: meta.id,
      offset: 0,
    });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of download.chunks) chunks.push(chunk);
    } finally {
      await download.close();
    }
    expect(Buffer.concat(chunks)).toEqual(await readFile(stored.path));
    expect(meta.bytes).toBe(stored.bytes);
  });
  it("concurrent log subscriptions followed by stop do not retain an old delivery slot", async () => {
    const h = await harness();
    await bind(h);
    const seen: string[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      send: async (msg) => {
        if (msg.type === "devices.logs") seen.push(...msg.lines);
      },
      media: { write: async () => {}, bufferedBytes: () => 0 },
    });
    cleanups.push(async () => peer.close());
    await Promise.all(
      [1, 2].map((id) =>
        peer.request({
          type: "devices.request",
          requestId: String(id),
          operation: { op: "logs.start", deviceId },
        }),
      ),
    );
    await peer.request({
      type: "devices.request",
      requestId: "stoplogs",
      operation: { op: "logs.stop", deviceId },
    });
    const barrier = deferred<void>();
    await h.service.subscribeLogs(deviceId, human, async () => {
      barrier.resolve();
    });
    await h.request({ op: "logs.start", deviceId });
    h.log("after-unsubscribe");
    await barrier.promise;
    expect(seen).toEqual([]);
  });
  it("disable waits for delayed native startup and native termination before clearing state", async () => {
    const h = await harness();
    await bind(h);
    const factoryGate = h.blockCapture();
    const stopGate = h.blockStop();
    const starting = h.request({ op: "start", deviceId });
    await h.captureEntered.promise;
    let disabled = false;
    const beganStopping = deferred<void>();
    h.service.watch((state) => {
      if (state.lifecycle === "stopping") beganStopping.resolve();
    });
    const stopping = h.request({ op: "enable", enabled: false }).then(() => {
      disabled = true;
    });
    await beganStopping.promise;
    expect(h.service.states()[0]?.lifecycle).toBe("stopping");
    expect(disabled).toBe(false);
    factoryGate.resolve();
    await h.stopEntered.promise;
    expect(h.service.states()[0]?.lifecycle).toBe("stopping");
    expect(disabled).toBe(false);
    stopGate.resolve();
    await stopping;
    await starting;
    expect((await h.nativeExit()).reason).toBe("stopped");
    expect(h.service.states()).toEqual([]);
  });
  it("slow inventory discovery does not consume the first-frame timeout", async () => {
    const h = await harness();
    await bind(h);
    const gate = h.blockInventory();
    const starting = h.request({ op: "start", deviceId });
    await h.inventoryEntered.promise;
    h.deadlines(10_000);
    gate.resolve();
    await starting;
    expect((await h.service.screenshot(deviceId, human)).payload.toString()).toBe("jpeg-0");
  });
  it("reenabling during disable cannot lose ownership of a pending native capture", async () => {
    const h = await harness();
    await bind(h);
    const gate = h.blockCapture();
    const starting = h.request({ op: "start", deviceId });
    await h.captureEntered.promise;
    const stopping = h.request({ op: "enable", enabled: false });
    await expect(h.request({ op: "enable", enabled: true })).rejects.toMatchObject({
      code: "busy",
    });
    gate.resolve();
    await stopping;
    await starting;
    expect((await h.nativeExit()).reason).toBe("stopped");
    expect(h.service.states()).toEqual([]);
  });
  it("cancelled native startup cleans up without making disable fail", async () => {
    const h = await harness(false, true);
    await bind(h);
    const gate = h.blockCapture();
    const starting = h.request({ op: "start", deviceId });
    const cancelled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await h.captureEntered.promise;
    const stopping = h.request({ op: "enable", enabled: false });
    gate.resolve();
    await stopping;
    await cancelled;
    expect((await h.nativeExit()).reason).toBe("stopped");
    expect(h.service.states()).toEqual([]);
  });
  it("capture cleanup failure still terminates logs and publishes the recording before failing", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    await h.request({ op: "logs.start", deviceId });
    await h.request({ op: "record.start", deviceId });
    h.failStop();
    await expect(h.request({ op: "stop", deviceId })).rejects.toThrow("cleanup");
    expect((await h.nativeExit()).reason).toBe("stopped");
    expect((await h.logExit()).reason).toBe("stopped");
    expect(h.publications).toHaveLength(1);
    expect(h.service.states()[0]?.lifecycle).toBe("failed");
    await expect(h.request({ op: "start", deviceId })).rejects.toMatchObject({ code: "busy" });
    h.clearStopFailure();
  });
  it("moving a device to another thread clears old log tails, log subscriptions and recordings", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    const received = deferred<void>();
    const oldLines: string[] = [];
    await h.service.subscribeLogs(deviceId, human, async (batch) => {
      oldLines.push(...batch.lines);
      received.resolve();
    });
    await h.request({ op: "logs.start", deviceId });
    h.log("thread-A-secret");
    await received.promise;
    await h.request({ op: "record.start", deviceId });
    h.publish(1, 600);
    await h.published.promise;
    await delegateTo(h, "thread-2");
    await expect(h.request({ op: "record.stop", deviceId })).rejects.toMatchObject({
      code: "not_found",
    });
    const fresh = deferred<void>();
    await h.service.subscribeLogs(deviceId, human, async () => {
      fresh.resolve();
    });
    await h.request({ op: "logs.start", deviceId });
    h.log("thread-B-line");
    await fresh.promise;
    expect(await h.request({ op: "logs", deviceId, limit: 256 })).toMatchObject({
      lines: ["thread-B-line"],
    });
    expect(oldLines).toEqual(["thread-A-secret"]);
  });
  it("a recording stop begun for one thread cannot return metadata after the device moves", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    const gate = h.blockPublication();
    await h.request({ op: "record.start", deviceId });
    const stopping = h.request({ op: "record.stop", deviceId });
    const rejected = expect(stopping).rejects.toMatchObject({ code: "busy" });
    await h.publishing.promise;
    const entered = deferred<void>();
    h.service.watch((state) => {
      if (state.lifecycle === "stopping") entered.resolve();
    });
    let moved = false;
    const moving = delegateTo(h, "thread-2").then(() => {
      moved = true;
    });
    await entered.promise;
    expect(moved).toBe(false);
    gate.resolve();
    await rejected;
    await moving;
    await expect(h.request({ op: "record.stop", deviceId })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("concurrent subscriptions followed by unsubscribe leave no hidden frame subscriber", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId });
    const packets: Uint8Array[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      send: async () => {},
      media: {
        bufferedBytes: () => 0,
        write: async (piece) => {
          packets.push(piece);
        },
      },
    });
    cleanups.push(async () => peer.close());
    await Promise.all(
      [1, 2].map((id) =>
        peer.request({
          type: "devices.request",
          requestId: String(id),
          operation: { op: "subscribe", deviceId },
        }),
      ),
    );
    await peer.request({
      type: "devices.request",
      requestId: "unsub",
      operation: { op: "unsubscribe", deviceId },
    });
    // Pictures already handed to the transport finish writing first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prior = packets.length;
    const delivered = deferred<void>();
    await h.service.subscribe(deviceId, human, async (image) => {
      if (image.header.sequence === 99) delivered.resolve();
    });
    h.publish(99);
    await delivered.promise;
    expect(packets).toHaveLength(prior);
  });
  it("log delivery rechecks the authenticated reader's current thread grant", async () => {
    const h = await harness();
    await bind(h);
    let allowed = true;
    const seen: string[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => allowed,
      agentExists: () => true,
      send: async (message) => {
        if (message.type === "devices.logs") seen.push(...message.lines);
      },
      media: { write: async () => {}, bufferedBytes: () => 0 },
    });
    cleanups.push(async () => peer.close());
    await peer.request({
      type: "devices.request",
      requestId: "logs",
      operation: { op: "logs.start", deviceId },
    });
    const barrier = deferred<void>();
    await h.service.subscribeLogs(deviceId, human, async () => {
      barrier.resolve();
    });
    allowed = false;
    h.log("secret-after-revocation");
    await barrier.promise;
    expect(seen).toEqual([]);
  });
  it("MCP requires a devices capability and cannot forge the delegated caller", async () => {
    const h = await harness();
    await delegate(h);
    const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
    devicesToolkit(h.service).register(registry);
    expect(registry.action("sim_ui", { simId: deviceId })).toMatchObject({
      origin: "ace",
      riskClass: "read-only",
      access: "read",
      description: expect.stringContaining(deviceId),
    });
    expect(
      registry.action("sim_act", { simId: deviceId, action: "tap", x: 3, y: 4 }),
    ).toMatchObject({
      origin: "ace",
      riskClass: "external-effect",
      access: "write",
      description: expect.stringContaining("tap"),
    });
    // A second owner cannot replace the first toolkit's authorized bindings.
    expect(() => devicesToolkit(h.service).register(registry)).toThrow(
      "Invalid or duplicate tool name",
    );
    let secret = 0;
    const credentials = new CredentialRegistry(() => String(++secret).padStart(64, "0"));
    const lifetime = new AbortController();
    const denied = credentials.issue(
      {
        sessionId: "mcp-1",
        threadId: ThreadId.parse("thread-1"),
        agentId: AgentId.parse("agent-1"),
        capabilities: [],
      },
      lifetime.signal,
    );
    expect(
      (
        await registry.call(
          "sim_act",
          { simId: deviceId, action: "tap", x: 3, y: 4 },
          denied.principal,
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    const allowed = credentials.issue(
      {
        sessionId: "mcp-2",
        threadId: ThreadId.parse("thread-1"),
        agentId: AgentId.parse("agent-1"),
        capabilities: ["devices"],
      },
      lifetime.signal,
    );
    expect(
      (
        await registry.call(
          "sim_act",
          { simId: deviceId, action: "tap", x: 3, y: 4, threadId: "thread-2" },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await registry.call(
          "sim_act",
          { simId: deviceId, action: "tap", x: 3, y: 4 },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).not.toBe(true);
    lifetime.abort();
    expect(
      (
        await registry.call(
          "sim_act",
          { simId: deviceId, action: "tap", x: 3, y: 4 },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(h.effects).toHaveLength(1);
    credentials.close();
  });
  it("an agent takes a free device through MCP with no prompt, but never one someone controls", async () => {
    const h = await harness();
    await h.request({ op: "enable", enabled: true });
    const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
    devicesToolkit(h.service).register(registry);
    let secret = 0;
    const credentials = new CredentialRegistry(() => String(++secret).padStart(64, "0"));
    cleanups.push(async () => credentials.close());
    const lifetime = new AbortController();
    const callAs = (threadId: string, agentId: string) => {
      const lease = credentials.issue(
        {
          sessionId: `mcp-${threadId}-${agentId}`,
          threadId: ThreadId.parse(threadId),
          agentId: AgentId.parse(agentId),
          capabilities: ["devices"],
        },
        lifetime.signal,
      );
      return async (name: string, args: Record<string, unknown>) =>
        registry.call(
          name,
          { simId: deviceId, ...args },
          lease.principal,
          new AbortController().signal,
        );
    };
    const first = callAs("thread-1", "agent-1"),
      second = callAs("thread-2", "agent-2");
    expect((await first("sim_start", {})).isError).not.toBe(true);
    expect((await first("sim_act", { action: "tap", x: 3, y: 4 })).isError).not.toBe(true);
    expect(h.effects).toEqual([expect.stringContaining("'tap' '3' '4'")]);
    expect(h.service.states()[0]).toMatchObject({
      threadId: "thread-1",
      controller: "agent",
      holder: { threadId: "thread-1", agentId: "agent-1" },
    });
    expect(JSON.stringify(await second("sim_start", {}))).toContain("busy");
    await h.request({ op: "controller", deviceId, controller: "human" });
    expect(JSON.stringify(await first("sim_start", {}))).toContain("lease_required");
    expect(h.service.states()[0]?.controller).toBe("human");
    await h.request({ op: "controller", deviceId, controller: "none" });
    expect((await second("sim_start", {})).isError).not.toBe(true);
    expect(h.service.states()[0]).toMatchObject({
      threadId: "thread-2",
      holder: { threadId: "thread-2", agentId: "agent-2" },
    });
    lifetime.abort();
  });
  it("sim_act performs each gesture, text and key action on the simulator it took", async () => {
    const h = await harness();
    await h.request({ op: "enable", enabled: true });
    const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
    devicesToolkit(h.service).register(registry);
    const credentials = new CredentialRegistry(() => "a".repeat(64));
    cleanups.push(async () => credentials.close());
    const lease = credentials.issue(
      {
        sessionId: "sim-act",
        threadId: ThreadId.parse("thread-1"),
        agentId: AgentId.parse("agent-1"),
        capabilities: ["devices"],
      },
      new AbortController().signal,
    );
    const call = (name: string, args: Record<string, unknown>) =>
      registry.call(
        name,
        { simId: deviceId, ...args },
        lease.principal,
        new AbortController().signal,
      );
    const started = await call("sim_start", {});
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
    expect(started.content).toMatchObject([
      { text: expect.stringContaining(`"simId":"${deviceId}"`) },
    ]);
    for (const args of [
      { action: "tap", x: 3, y: 4 },
      { action: "long_press", x: 5, y: 6, durationMs: 700 },
      { action: "swipe", x: 1, y: 2, toX: 7, toY: 8 },
      { action: "type", text: "hello" },
      { action: "key", key: "back" },
    ]) {
      const result = await call("sim_act", args);
      expect(result.isError, `${args.action}: ${JSON.stringify(result.content)}`).not.toBe(true);
    }
    expect(h.effects).toEqual([
      expect.stringMatching(/'tap' '3' '4'/),
      expect.stringMatching(/'swipe' '5' '6' '5' '6' '700'/),
      expect.stringMatching(/'swipe' '1' '2' '7' '8'/),
      expect.stringMatching(/'text' 'hello'/),
      expect.stringMatching(/'keyevent'/),
    ]);
    const stray = await call("sim_act", { action: "tap", x: 1, y: 2, text: "stray" });
    expect(stray).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"path":"text"') }],
    });
    expect(h.effects).toHaveLength(5);
  });
});

const videoProfile = {
  codec: "h264",
  maxWidth: 320,
  maxHeight: 640,
  fps: 60,
  bitrate: 500000,
} as const;
for (const op of ["subscribe", "stream.configure"] as const) {
  it(`${op} racing disconnect cannot retain a JPEG viewer or exhaust viewer capacity`, async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId, fps: 60 });
    await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
    for (let n = 0; n < 70; n++) {
      const owner = `departed-${n}`;
      const channel = connectDevices(h.service, owner, {
        authorize: () => true,
        canReadThread: () => true,
        agentExists: () => true,
        async send() {},
        media: { write: async () => {}, bufferedBytes: () => 0 },
      });
      const pending = channel.request({
        type: "devices.request",
        requestId: `race-${n}`,
        operation:
          op === "subscribe"
            ? { op, deviceId }
            : { op, deviceId, settings: { ...videoProfile, codec: "jpeg" } },
      });
      // Even a cached session lookup yields before the preference insertion.
      channel.close();
      await pending;
    }
    await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
    expect(h.profiles.at(-1)).toEqual(videoProfile);
    expect(h.profiles.every((profile) => profile.codec === "h264")).toBe(true);
  });
}
it("recording quota completion restores video without increasing a small viewer's budget", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  await h.request({ op: "record.start", deviceId });
  expect(h.profiles.at(-1)).toEqual({ ...videoProfile, codec: "jpeg", fps: 15 });
  h.publish(1, 1024);
  await h.published.promise;
  await h.request({ op: "record.stop", deviceId });
  expect(h.profiles.at(-1)).toEqual(videoProfile);
});

{
  it("a congested screenshot rejects and can subsequently deliver pixels", async () => {
    const h = await harness();
    await bind(h);
    await h.request({ op: "start", deviceId, fps: 30 });
    let buffered = 192 * 1024;
    const results: import("@ace/protocol/devices").DeviceServerMessage[] = [];
    const packets: Uint8Array[] = [];
    const channel = connectDevices(h.service, "congested", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      async send(message) {
        results.push(message);
      },
      media: {
        bufferedBytes: () => buffered,
        write: async (piece) => {
          packets.push(piece);
        },
      },
    });
    const screenshot = (requestId: string) =>
      channel.request({
        type: "devices.request",
        requestId,
        operation: { op: "screenshot", deviceId },
      });
    await screenshot("blocked");
    expect(packets).toEqual([]);
    expect(results.at(-1)).toMatchObject({
      type: "devices.result",
      requestId: "blocked",
      ok: false,
    });
    buffered = 0;
    await screenshot("ready");
    const assembler = new StreamAssembler();
    const stills = packets.flatMap((piece) => {
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      return message?.kind === "device.frame" && message.frame.still ? [message.frame] : [];
    });
    expect(Buffer.from(stills[0]?.bytes ?? []).toString()).toBe("jpeg-0");
    expect(results.at(-1)).toMatchObject({ type: "devices.result", requestId: "ready", ok: true });
    channel.close();
  });
}

it("recording startup failure releases its image lease and permits a later attempt", async () => {
  const h = await harness(false, false, "/dev/null/ace-recording");
  await bind(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  for (let i = 0; i < 2; i++) {
    await expect(h.request({ op: "record.start", deviceId })).rejects.toBeInstanceOf(Error);
    expect(h.profiles.at(-1)).toEqual(videoProfile);
  }
});
it("recording quota releases image demand before a stalled publisher completes", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  const publication = h.blockPublication();
  await h.request({ op: "record.start", deviceId });
  h.publish(1, 1024);
  await h.publishing.promise;
  // A new settings acknowledgement joins the already-requested image release.
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  expect(h.profiles.at(-1)).toEqual(videoProfile);
  publication.resolve();
  await h.request({ op: "record.stop", deviceId });
});

it("unsubscribing removes its JPEG preference and restores the remaining video viewer", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  const release = await h.service.subscribe(
    deviceId,
    { kind: "human", owner: "image-viewer" },
    async () => {},
  );
  expect(h.profiles.at(-1)?.codec).toBe("jpeg");
  release();
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  expect(h.profiles.at(-1)).toEqual(videoProfile);
});

it("a pending native control handoff cannot reclaim after a newer owner or disconnect", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId });
  const gate = h.blockRelease();
  const first = h.request({ op: "controller", deviceId, controller: "human" });
  const rejectedFirst = expect(first).rejects.toThrow("Device control changed");
  await h.releaseEntered.promise;
  const other = { kind: "human" as const, owner: "phone-2" };
  const second = h.request({ op: "controller", deviceId, controller: "human" }, other);
  gate.resolve();
  await rejectedFirst;
  await second;
  expect(h.service.states()[0]?.controller).toBe("human");
  const gate2 = h.blockRelease();
  const pending = h.request({ op: "controller", deviceId, controller: "human" });
  const rejected = expect(pending).rejects.toThrow("Device control changed");
  await Promise.resolve();
  await Promise.resolve();
  h.service.disconnect(human.owner);
  gate2.resolve();
  await rejected;
  expect(h.service.states()[0]?.controller).toBe("none");
});

it("boot stays visibly booting and succeeds after the controller's idle deadline", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "controller", deviceId, controller: "human" });
  const gate = h.blockInventory();
  const booting = h.request({ op: "boot", deviceId });
  await h.inventoryEntered.promise;
  h.time(240000);
  h.deadlines();
  expect(h.service.states()[0]).toMatchObject({ booting: true, controller: "human" });
  gate.resolve();
  await booting;
  expect(h.service.states()[0]).toMatchObject({ booting: false, device: { state: "booted" } });
});
it("a long installation succeeds without expiring its queued controller", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "controller", deviceId, controller: "human" });
  const gate = h.blockInput();
  const installing = h.request({ op: "install", deviceId, path: "/tmp/Example.apk" });
  await h.entered.promise;
  h.time(240000);
  h.deadlines();
  gate.resolve();
  expect(await installing).toEqual({ completed: true });
  expect(h.effects).toEqual(["-s emulator-5554 install -r /tmp/Example.apk"]);
});
it("an agent installation lasting six minutes returns success through MCP", async () => {
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
      sessionId: "install-session",
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
    { simId: deviceId, action: "install", path: "/tmp/Example.apk" },
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
  expect(h.effects).toEqual(["-s emulator-5554 install -r /tmp/Example.apk"]);
});
it("an agent taking a device restores the live view a person was watching", async () => {
  const h = await harness();
  await h.request({ op: "enable", enabled: true });
  await h.request({ op: "start", deviceId });
  await h.service.claimForAgent(deviceId, agent);
  expect((await h.service.screenshot(deviceId, human)).payload.toString()).toBe("jpeg-0");
  expect(h.service.states()[0]?.lifecycle).toBe("live");
});
it("a failed capture stop exposes cleanup and retry permits a replacement live view", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId });
  h.failStop();
  await expect(h.request({ op: "stop", deviceId })).rejects.toThrow();
  expect(h.service.states()[0]?.cleanupRequired).toBe(true);
  h.clearStopFailure();
  await h.request({ op: "stop", deviceId });
  await h.request({ op: "start", deviceId });
  expect((await h.service.screenshot(deviceId, human)).payload.toString()).toBe("jpeg-0");
});
it("a first-frame timeout explains how to repair the Android live view", async () => {
  const h = await harness();
  await bind(h);
  h.skipFirstFrame();
  const starting = h.request({ op: "start", deviceId });
  const rejected = expect(starting).rejects.toMatchObject({
    code: "timeout",
    message: "The live view didn't send its first frame",
    hint: expect.stringContaining("ffmpeg"),
  });
  await h.frameDeadline.promise;
  h.deadlines();
  await rejected;
  expect(h.service.states()[0]?.error?.hint).not.toContain("Screen Recording");
});
it("reaching a recording limit reports why capture stopped and publishes its video", async () => {
  const h = await harness();
  await bind(h);
  await h.request({ op: "start", deviceId });
  await h.request({ op: "record.start", deviceId });
  h.publish(1, 600);
  await h.published.promise;
  expect(h.service.states()[0]).toMatchObject({
    recording: false,
    recordingNotice: expect.stringContaining("size limit"),
  });
  expect(await h.request({ op: "record.stop", deviceId })).toMatchObject({
    bytes: expect.any(Number),
  });
});
