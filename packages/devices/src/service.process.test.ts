import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService } from "@ace/files";
import { basename } from "node:path";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { DeviceOperation, type DeviceInput } from "@ace/protocol/devices";
import { framePacket, type Frame, type RecordingArtifact } from "@ace/screen";
import {
  spawnRawSupervised,
  spawnSupervised,
  type SupervisedProcess,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import {
  DevicesService,
  DevicePlatform,
  devicesToolkit,
  agentOwner,
  connectDevices,
  type Actor,
  devicePacketDelivery,
  sendDeviceFrame,
} from "./index.ts";
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
async function harness(withRegistry = false, cancelCapture = false, recordingDirectory?: string) {
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
  const files = withRegistry
    ? await FilesService.create({
        workspace: root,
        dataDir: join(root, "registry"),
        artifactRoots: [root],
        now: () => now,
        id: () => `artifact-${++id}`,
        authorize: () => true,
      })
    : undefined;
  if (files) cleanups.push(async () => files.close());
  const effects: string[] = [];
  const profiles: import("@ace/protocol").ScreenStreamSettings[] = [];
  const publications: RecordingArtifact[] = [];
  const published = deferred<void>();
  const publishing = deferred<void>();
  let publicationGate: ReturnType<typeof deferred<void>> | undefined;
  let native: RawSupervisedProcess | undefined;
  let logProcess: SupervisedProcess | undefined;
  let stopFailure = false;
  let stopGate: ReturnType<typeof deferred<void>> | undefined;
  const stopEntered = deferred<void>();
  let captureOptions: Parameters<typeof startCapture>[0] | undefined;
  let inputGate: ReturnType<typeof deferred<void>> | undefined;
  let captureGate: ReturnType<typeof deferred<void>> | undefined;
  const captureEntered = deferred<void>();
  let inventoryEntered = deferred<void>();
  let inventoryGate: ReturnType<typeof deferred<void>> | undefined;
  const entered = deferred<void>();
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { ANDROID_HOME: root },
    async probe(_command, args) {
      const command = args.join(" ");
      if (command === "-list-avds") return { stdout: "Pixel", stderr: "", code: 0 };
      if (command === "devices -l") {
        if (inventoryGate) {
          inventoryEntered.resolve();
          await inventoryGate.promise;
        }
        return {
          stdout: "List of devices attached\nemulator-5554 device model:Pixel",
          stderr: "",
          code: 0,
        };
      }
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
    spawnLogs() {
      logProcess = spawnSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        env: {},
        name: "fake-device-log",
      });
      return logProcess;
    },
    recordingLimitBytes: 512,
    recordingDirectory: recordingDirectory ?? root,
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
      native = spawnRawSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        env: {},
        name: "fake-native-capture",
      });
      const owned = native;
      captureEntered.resolve();
      if (captureGate) await captureGate.promise;
      if (cancelCapture && options.signal?.aborted) {
        await owned.stop({ graceMs: 0 });
        throw new DOMException("Capture startup cancelled", "AbortError");
      }
      options.publish(frame(options.streamId, 0));
      return {
        async configure(settings) {
          profiles.push(settings);
          return { codec: settings.codec };
        },
        async stop() {
          stopEntered.resolve();
          if (stopGate) await stopGate.promise;
          await owned.stop({ graceMs: 0 });
          if (stopFailure) throw new Error("native cleanup failed");
        },
      };
    },
    async publishArtifact(artifact) {
      publications.push(artifact);
      publishing.resolve();
      if (publicationGate) await publicationGate.promise;
      published.resolve();
      if (files) {
        const registered = await files.registerArtifact({
          root,
          path: basename(artifact.path),
          name: "device.screen",
          category: "recording",
        });
        return { id: registered, bytes: artifact.bytes, mimeType: artifact.mimeType };
      }
      return { ...artifact };
    },
  });
  cleanups.push(() => service.close());
  const request = (raw: unknown, actor = human) =>
    service.request(DeviceOperation.parse(raw), actor);
  return {
    service,
    profiles,
    request,
    effects,
    publications,
    published,
    publishing,
    blockPublication() {
      publicationGate = deferred<void>();
      return publicationGate;
    },
    files,
    entered,
    captureEntered,
    get inventoryEntered() {
      return inventoryEntered;
    },
    blockInventory() {
      inventoryEntered = deferred<void>();
      inventoryGate = deferred<void>();
      return inventoryGate;
    },
    deadlines() {
      for (const run of timers.keys()) run();
    },
    nativeStarted() {
      return native !== undefined;
    },
    stopEntered,
    nativeExit() {
      if (!native) throw new Error("No native capture");
      return native.exited;
    },
    logExit() {
      if (!logProcess) throw new Error("No log process");
      return logProcess.exited;
    },
    log(line: string) {
      if (!logProcess) throw new Error("No log process");
      logProcess.stdin.write(line + "\n");
    },
    failStop() {
      stopFailure = true;
    },
    clearStopFailure() {
      stopFailure = false;
    },
    blockStop() {
      stopGate = deferred<void>();
      return stopGate;
    },
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
    publish(sequence: number, bytes?: number) {
      if (!captureOptions) throw new Error("Capture is not started");
      const image = frame(captureOptions.streamId, sequence);
      if (bytes !== undefined) {
        image.payload = Buffer.alloc(bytes, 7);
        image.header = { ...image.header, bytes };
        image.packet = framePacket(image.header, image.payload);
      }
      captureOptions.publish(image);
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
  it("recording publishes the actual stored screen packets and opaque metadata", async () => {
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
  it("recording enforces its byte cap and downloads the registered bytes through the artifact API", async () => {
    const h = await harness(true);
    await approve(h);
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
    await approve(h);
    const seen: string[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      send: async (msg) => {
        if (msg.type === "devices.logs") seen.push(...msg.lines);
      },
      image: async () => {},
      frame: async () => {},
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
    await approve(h);
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
  it("startup expiry during SDK lookup fails without dispatching native capture", async () => {
    const h = await harness();
    await approve(h);
    const gate = h.blockInventory();
    const starting = h.request({ op: "start", deviceId });
    const failed = expect(starting).rejects.toMatchObject({ code: "timeout" });
    await h.inventoryEntered.promise;
    h.deadlines();
    gate.resolve();
    await failed;
    expect(h.nativeStarted()).toBe(false);
    expect(h.service.states()[0]?.lifecycle).toBe("failed");
  });
  it("reenabling during disable cannot lose ownership of a pending native capture", async () => {
    const h = await harness();
    await approve(h);
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
    await approve(h);
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
    await approve(h);
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
  it("reapproval clears old log tails, old log subscriptions and completed recording ownership", async () => {
    const h = await harness();
    await approve(h);
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
    await h.request({ op: "approve", deviceId, threadId: "thread-2", allowed: true });
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
  it("a recording stop begun under an old approval cannot return metadata after reapproval", async () => {
    const h = await harness();
    await approve(h);
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
    let approved = false;
    const approving = h
      .request({ op: "approve", deviceId, threadId: "thread-2", allowed: true })
      .then(() => {
        approved = true;
      });
    await entered.promise;
    expect(approved).toBe(false);
    gate.resolve();
    await rejected;
    await approving;
    await expect(h.request({ op: "record.stop", deviceId })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("concurrent subscriptions followed by unsubscribe leave no hidden frame subscriber", async () => {
    const h = await harness();
    await approve(h);
    await h.request({ op: "start", deviceId });
    const packets: Buffer[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      send: async () => {},
      image: async () => {},
      frame: async (packet) => {
        packets.push(packet);
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
    await approve(h);
    let allowed = true;
    const seen: string[] = [];
    const peer = connectDevices(h.service, "reader", {
      authorize: () => true,
      canReadThread: () => allowed,
      agentExists: () => true,
      send: async (message) => {
        if (message.type === "devices.logs") seen.push(...message.lines);
      },
      image: async () => {},
      frame: async () => {},
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
    expect(registry.action("device_ui_tree", { deviceId })).toMatchObject({
      origin: "ace",
      riskClass: "read-only",
      access: "read",
      description: expect.stringContaining(deviceId),
    });
    expect(registry.action("device_tap", { deviceId, x: 3, y: 4 })).toMatchObject({
      origin: "ace",
      riskClass: "external-effect",
      access: "write",
      description: expect.stringContaining("Tap"),
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
    await approve(h);
    await h.request({ op: "start", deviceId, fps: 60 });
    await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
    for (let n = 0; n < 70; n++) {
      const owner = `departed-${n}`;
      const channel = connectDevices(h.service, owner, {
        authorize: () => true,
        canReadThread: () => true,
        agentExists: () => true,
        async send() {},
        async frame() {},
        async image() {},
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
  await approve(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  await h.request({ op: "record.start", deviceId });
  expect(h.profiles.at(-1)).toEqual({ ...videoProfile, codec: "jpeg" });
  h.publish(1, 1024);
  await h.published.promise;
  await h.request({ op: "record.stop", deviceId });
  expect(h.profiles.at(-1)).toEqual(videoProfile);
});

for (const relay of [false, true]) {
  it(`a congested ${relay ? "relay" : "local"} screenshot rejects and can subsequently deliver pixels`, async () => {
    const h = await harness();
    await approve(h);
    await h.request({ op: "start", deviceId, fps: 30 });
    let buffered = 192 * 1024;
    const results: import("@ace/protocol/devices").DeviceServerMessage[] = [];
    const packets: Uint8Array[] = [];
    const delivery = devicePacketDelivery({
      bufferedBytes: () => buffered,
      authorize: () => true,
      write: async (packet) => {
        if (relay)
          await sendDeviceFrame(
            packet,
            async (bytes) => {
              packets.push(bytes);
            },
            () => true,
          );
        else packets.push(packet);
      },
    });
    const channel = connectDevices(h.service, "congested", {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      async send(message) {
        results.push(message);
      },
      ...delivery,
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
    expect(Buffer.concat(packets).includes(Buffer.from("jpeg-0"))).toBe(true);
    expect(results.at(-1)).toMatchObject({ type: "devices.result", requestId: "ready", ok: true });
    channel.close();
  });
}

it("recording startup failure releases its image lease and permits a later attempt", async () => {
  const h = await harness(false, false, "/dev/null/ace-recording");
  await approve(h);
  await h.request({ op: "start", deviceId, fps: 60 });
  await h.request({ op: "stream.configure", deviceId, settings: videoProfile });
  for (let i = 0; i < 2; i++) {
    await expect(h.request({ op: "record.start", deviceId })).rejects.toBeInstanceOf(Error);
    expect(h.profiles.at(-1)).toEqual(videoProfile);
  }
});
it("recording quota releases image demand before a stalled publisher completes", async () => {
  const h = await harness();
  await approve(h);
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
  await approve(h);
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
