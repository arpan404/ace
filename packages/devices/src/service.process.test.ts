import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { DeviceOperation, type DeviceInput } from "@ace/protocol/devices";
import { framePacket, type Frame, type RecordingArtifact } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicesService, DevicePlatform, devicesToolkit, agentOwner, type Actor } from "./index.ts";
import type { startCapture } from "./capture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function noop() {}
function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const human: Actor = { kind: "human", owner: "phone-1" };
const agent: Actor = {
  kind: "agent",
  threadId: "thread-1",
  agentId: "agent-1",
  owner: agentOwner("thread-1", "agent-1"),
};
const deviceId = "android:Pixel";
function frame(streamId: string, sequence: number): Frame {
  const payload = Buffer.from(`jpeg-${sequence}`);
  const header = {
    version: 1 as const,
    sessionId: streamId,
    sequence,
    timestamp: sequence,
    width: 100,
    height: 200,
    codec: "jpeg" as const,
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "ace-devices-service-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const path of ["platform-tools/adb", "emulator/emulator"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, path), 0o700);
  }
  let now = 0;
  let id = 0;
  const timers = new Map<() => void, number>();
  const effects: string[] = [];
  const publications: RecordingArtifact[] = [];
  let captureOptions: Parameters<typeof startCapture>[0] | undefined;
  let inputGate: ReturnType<typeof deferred<void>> | undefined;
  let captureGate: ReturnType<typeof deferred<void>> | undefined;
  const captureEntered = deferred<void>();
  const entered = deferred<void>();
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { ANDROID_HOME: root },
    async probe(_command, args) {
      const command = args.join(" ");
      if (command === "-list-avds") return { stdout: "Pixel", stderr: "", code: 0 };
      if (command === "devices -l")
        return {
          stdout: "List of devices attached\nemulator-5554 device model:Pixel",
          stderr: "",
          code: 0,
        };
      if (command.endsWith("emu avd name")) return { stdout: "Pixel\nOK", stderr: "", code: 0 };
      if (command.includes("input")) {
        effects.push(command);
        entered.resolve();
        if (inputGate) await inputGate.promise;
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: root,
    runtime: {
      now: () => now,
      id: () => `device-stream-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        timers.set(run, now + ms);
        return () => {
          timers.delete(run);
        };
      },
    },
    async capture(options) {
      captureOptions = options;
      captureEntered.resolve();
      if (captureGate) await captureGate.promise;
      options.publish(frame(options.streamId, 0));
      return { async stop() {} };
    },
    async publishArtifact(artifact) {
      publications.push(artifact);
      return { ...artifact };
    },
  });
  cleanups.push(() => service.close());
  const request = (raw: unknown, actor = human) =>
    service.request(DeviceOperation.parse(raw), actor);
  return {
    service,
    request,
    effects,
    publications,
    entered,
    captureEntered,
    blockCapture() {
      captureGate = deferred<void>();
      return captureGate;
    },
    blockInput() {
      inputGate = deferred<void>();
      return inputGate;
    },
    time(at: number) {
      now = at;
    },
    publish(sequence: number) {
      if (!captureOptions) throw new Error("Capture is not started");
      captureOptions.publish(frame(captureOptions.streamId, sequence));
    },
    fail() {
      captureOptions?.failure(new Error("capture disconnected"));
    },
  };
}
async function approve(h: Awaited<ReturnType<typeof harness>>) {
  await h.request({ op: "enable", enabled: true });
  await h.request({ op: "approve", deviceId, threadId: "thread-1", allowed: true });
}
async function delegate(h: Awaited<ReturnType<typeof harness>>) {
  await approve(h);
  await h.request({
    op: "controller",
    deviceId,
    controller: "agent",
    threadId: "thread-1",
    agentId: "agent-1",
  });
}
describe("in-app device ownership", () => {
  it("agents cannot enable or approve their own device", async () => {
    const h = await harness();
    await expect(h.request({ op: "enable", enabled: true }, agent)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await h.request({ op: "enable", enabled: true });
    await expect(
      h.request({ op: "approve", deviceId, threadId: "thread-1", allowed: true }, agent),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(h.effects).toEqual([]);
  });
  it("an approved device still rejects a different agent or thread", async () => {
    const h = await harness();
    await delegate(h);
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
    ).rejects.toMatchObject({ code: "permission_denied" });
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
  it("expired or disconnected controllers cannot continue injecting input", async () => {
    const h = await harness();
    await delegate(h);
    h.time(30001);
    await expect(
      h.request({ op: "input", deviceId, input: { kind: "key", key: "home" } }, agent),
    ).rejects.toMatchObject({ code: "lease_required" });
    await h.request({ op: "controller", deviceId, controller: "human" });
    h.service.disconnect(human.owner);
    await expect(
      h.request({ op: "input", deviceId, input: { kind: "key", key: "home" } }),
    ).rejects.toMatchObject({ code: "lease_required" });
    expect(h.effects).toEqual([]);
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
  it("revocation clears live pixels and prevents later agent screenshots", async () => {
    const h = await harness();
    await delegate(h);
    await h.request({ op: "start", deviceId });
    expect((await h.service.screenshot(deviceId, agent)).payload.toString()).toBe("jpeg-0");
    await h.request({ op: "approve", deviceId, threadId: "thread-1", allowed: false });
    h.publish(1);
    await expect(h.service.screenshot(deviceId, agent)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(h.service.screenshot(deviceId, human)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("slow viewers skip intermediate frames while another viewer receives the latest frame", async () => {
    const h = await harness();
    await approve(h);
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
  it("recording stores bounded screen packets and publishes a downloadable artifact", async () => {
    const h = await harness();
    await approve(h);
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
  it("disabling during capture startup leaves no failed or live device behind", async () => {
    const h = await harness();
    await approve(h);
    const gate = h.blockCapture();
    const states: string[] = [];
    h.service.watch((state) => states.push(state.lifecycle));
    const starting = h.request({ op: "start", deviceId });
    await h.captureEntered.promise;
    await h.request({ op: "enable", enabled: false });
    const afterDisable = states.length;
    gate.resolve();
    await starting;
    expect(h.service.states()).toEqual([]);
    expect(states.slice(afterDisable)).toEqual([]);
    await expect(h.service.screenshot(deviceId, human)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
  it("MCP requires a devices capability and cannot forge the delegated caller", async () => {
    const h = await harness();
    await delegate(h);
    const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
    devicesToolkit(h.service).register(registry);
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
          "device_tap",
          { deviceId, x: 3, y: 4 },
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
          "device_tap",
          { deviceId, x: 3, y: 4, threadId: "thread-2" },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await registry.call(
          "device_tap",
          { deviceId, x: 3, y: 4 },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).not.toBe(true);
    lifetime.abort();
    expect(
      (
        await registry.call(
          "device_tap",
          { deviceId, x: 3, y: 4 },
          allowed.principal,
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(h.effects).toHaveLength(1);
    credentials.close();
  });
});
