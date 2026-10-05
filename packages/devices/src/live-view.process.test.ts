import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished, vi } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { nodeBinary } from "@ace/provider-kit/testing";
import { ScreenManager } from "@ace/screen";
import type { DeviceServerMessage } from "@ace/protocol/devices";
import { DeviceClient, DeviceClientError, type DeviceTransport } from "./client.ts";
import { DevicesService, DevicePlatform, connectDevices } from "./index.ts";

/*
 * The iOS Simulator live view end to end, minus macOS: a fake `xcrun simctl` keeps the
 * simulator's state in a file, a fake screen helper stands in for AceScreenHelper.app (its
 * macOS permissions in a file a test can flip), and a real DevicesService, ScreenManager,
 * devices bridge and DeviceClient sit in between, as in the daemon and the app.
 */
const udid = "22222222-2222-4222-8222-222222222222";
const deviceId = `ios:${udid}`;

async function fixture(
  options: {
    screenRecording?: boolean;
    accessibility?: boolean;
    frontmost?: boolean;
    pollMs?: number;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "ace-live-view-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  const state = join(home, "simulator-state");
  await writeFile(state, "shutdown");
  const permissions = join(home, "permissions.json");
  const grant = (value: { screenRecording: boolean; accessibility: boolean }) =>
    writeFile(permissions, JSON.stringify({ ...value, frontmost: options.frontmost ?? true }));
  await grant({
    screenRecording: options.screenRecording ?? true,
    accessibility: options.accessibility ?? true,
  });
  const journal = join(home, "helper.jsonl");
  await writeFile(journal, "");
  await nodeBinary(
    bin,
    "xcode-select",
    "console.log('/Applications/Xcode.app/Contents/Developer');",
  );
  await nodeBinary(bin, "open", "");
  await nodeBinary(
    bin,
    "xcrun",
    `const fs = require('node:fs'); const args = process.argv.slice(2);
    if (args.includes('list')) {
      fs.appendFileSync(process.env.SIMULATOR_READS, 'r');
      const state = fs.readFileSync(process.env.SIMULATOR_STATE,'utf8');
      // A read marked slow sees the state now and answers late, as a read racing a boot does.
      if (fs.existsSync(process.env.SIMULATOR_SLOW)) { fs.rmSync(process.env.SIMULATOR_SLOW); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }
      console.log(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-26-5':[{udid:'${udid}',name:'iPhone',state:state==='booted'?'Booted':'Shutdown',isAvailable:true}]}}));
    }
    else if (args.includes('boot')) fs.writeFileSync(process.env.SIMULATOR_STATE,'booted');
    else if (args.includes('shutdown')) fs.writeFileSync(process.env.SIMULATOR_STATE,'shutdown');`,
  );
  const reads = join(home, "reads");
  await writeFile(reads, "");
  const slow = join(home, "slow-read");
  const env = { PATH: bin, SIMULATOR_STATE: state, SIMULATOR_READS: reads, SIMULATOR_SLOW: slow };
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./testing/simulator-helper.ts", import.meta.url).pathname],
    platform: "darwin",
    env: { HELPER_JOURNAL: journal, HELPER_PERMISSIONS: permissions, HELPER_WINDOW: "iPhone" },
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    async publishArtifact() {},
  });
  const logged: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const service = new DevicesService({
    platform: new DevicePlatform({ platform: "darwin", home, env, screen }),
    screen,
    runtime: {
      now: Date.now,
      id: () => `device-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    env,
    recordingDirectory: home,
    async publishArtifact() {},
    inventoryIntervalMs: options.pollMs ?? 25,
    log: (level, message, fields) => logged.push({ level, message, fields }),
  });
  // The service stops its captures through the screen manager, so it closes first.
  onTestFinished(async () => {
    await service.close();
    await screen.close();
  });
  const helperJournal = async () =>
    (await readFile(journal, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  /** How many times the simulator inventory has been read. */
  const readCount = async () => (await readFile(reads, "utf8")).length;
  /** Make the next inventory read see the state now but answer 1.5 s later. */
  const slowNextRead = () => writeFile(slow, "");
  const slowReadStarted = () =>
    access(slow).then(
      () => false,
      () => true,
    );
  return {
    home,
    state,
    service,
    screen,
    grant,
    helperJournal,
    logged,
    readCount,
    slowNextRead,
    slowReadStarted,
  };
}

/** A devices client connected to the service through the bridge, as the app connects. */
function connect(service: DevicesService, owner = "browser-1") {
  const sent: DeviceServerMessage[] = [];
  let channel: ReturnType<typeof connectDevices> | undefined;
  const transport: DeviceTransport = {
    open(events) {
      channel = connectDevices(service, owner, {
        authorize: () => true,
        canReadThread: () => true,
        agentExists: () => true,
        async send(message) {
          sent.push(message);
          events.message(JSON.parse(JSON.stringify(message)));
        },
        async frame(packet) {
          events.message(new Uint8Array(packet));
        },
      });
      queueMicrotask(() => events.ready());
    },
    send(message) {
      void channel?.request(message);
    },
    close() {
      channel?.close();
    },
  };
  const client = new DeviceClient({
    id: () => crypto.randomUUID(),
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  });
  client.connect(transport);
  onTestFinished(() => client.disconnect());
  return { client, sent };
}

const deviceState = (client: DeviceClient) =>
  client.getSnapshot().states.find((state) => state.device.id === deviceId);

it("a simulator booted from ace reads as running for every watcher, without a refresh", async () => {
  // No background reads during the test: the boot itself must bring the new state.
  const f = await fixture({ pollMs: 3_600_000 });
  const { client } = connect(f.service);
  const other = connect(f.service, "browser-2");
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await vi.waitFor(() => expect(other.client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "controller", deviceId, controller: "human" });
  expect(deviceState(client)?.device.state).toBe("shutdown");

  await client.request({ op: "boot", deviceId });

  // The state pushed to both clients already says booted; nobody asked for the list again.
  expect(deviceState(client)?.device).toMatchObject({ state: "booted", runtime: "iOS 26.5" });
  await vi.waitFor(() => expect(deviceState(other.client)?.device.state).toBe("booted"));
});

it("boot and shutdown answer with the state after them, not a read that started before them", async () => {
  const f = await fixture({ pollMs: 3_600_000 });
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "controller", deviceId, controller: "human" });

  // A read already in flight saw the simulator off; it answers after the boot finishes.
  await f.slowNextRead();
  const earlier = client.request({ op: "list" });
  await vi.waitFor(async () => expect(await f.slowReadStarted()).toBe(true));
  await client.request({ op: "boot", deviceId });
  expect(deviceState(client)?.device.state).toBe("booted");
  await earlier;

  await f.slowNextRead();
  const before = client.request({ op: "list" });
  await vi.waitFor(async () => expect(await f.slowReadStarted()).toBe(true));
  await client.request({ op: "shutdown", deviceId });
  expect(deviceState(client)?.device.state).toBe("shutdown");
  await before;
});

it("turning devices on or off reaches every open view, even one with no device sessions", async () => {
  const f = await fixture();
  const quiet = connect(f.service, "window-2");
  const first = connect(f.service, "window-1");
  await vi.waitFor(() => expect(quiet.client.getSnapshot().connected).toBe(true));
  await vi.waitFor(() => expect(first.client.getSnapshot().connected).toBe(true));

  await first.client.request({ op: "enable", enabled: true });
  await vi.waitFor(() => expect(quiet.client.getSnapshot().enabled).toBe(true));
  await first.client.request({ op: "enable", enabled: false });
  await vi.waitFor(() => expect(quiet.client.getSnapshot().enabled).toBe(false));
});

it("a second view that has no device sessions yet still learns that devices are on", async () => {
  const f = await fixture();
  const first = connect(f.service, "window-1");
  await vi.waitFor(() => expect(first.client.getSnapshot().connected).toBe(true));
  await first.client.request({ op: "enable", enabled: true });
  expect(first.client.getSnapshot().enabled).toBe(true);

  const second = connect(f.service, "window-2");
  await vi.waitFor(() => expect(second.client.getSnapshot().connected).toBe(true));
  await second.client.request({ op: "states" });
  expect(second.client.getSnapshot()).toMatchObject({ enabled: true, states: [] });
});

it("a simulator booted or shut down outside ace shows up while a Devices view is open", async () => {
  const f = await fixture();
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "inventory.watch", watching: true });
  await client.request({ op: "list" });
  expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "shutdown" }]);

  await writeFile(f.state, "booted"); // xcrun simctl boot, from a terminal
  await vi.waitFor(() =>
    expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "booted" }]),
  );
  await writeFile(f.state, "shutdown");
  await vi.waitFor(() =>
    expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "shutdown" }]),
  );
});

it("without an open Devices view nothing reads the inventory in the background", async () => {
  const f = await fixture({ pollMs: 20 });
  // A connection that only observes device state (the app's main channel does this).
  const observer = connect(f.service, "main");
  await vi.waitFor(() => expect(observer.client.getSnapshot().connected).toBe(true));
  await observer.client.request({ op: "enable", enabled: true });
  await observer.client.request({ op: "list" });
  const idle = await f.readCount();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await f.readCount()).toBe(idle);

  // A Devices view keeps it current, until it closes.
  const view = connect(f.service, "devices-view");
  await vi.waitFor(() => expect(view.client.getSnapshot().connected).toBe(true));
  await view.client.request({ op: "inventory.watch", watching: true });
  await vi.waitFor(async () => expect(await f.readCount()).toBeGreaterThan(idle + 2));
  view.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closed = await f.readCount();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await f.readCount()).toBe(closed);
});

it("frames from the simulator's window reach a person's client, with no thread approval needed", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  client.watchFrames(deviceId, async (frame) => {
    shown.push(Buffer.from(frame.payload).toString());
  });

  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "subscribe", deviceId });

  expect(deviceState(client)).toMatchObject({ lifecycle: "live", approved: false });
  await vi.waitFor(() => expect(shown).toContain("simulator:home"));
});

it("input is refused without control and reaches the simulator with it", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  client.watchFrames(deviceId, async (frame) => {
    shown.push(Buffer.from(frame.payload).toString());
  });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "subscribe", deviceId });

  await expect(
    client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: "lease_required" });
  // Another person's connection can't drive the device someone else controls.
  const other = connect(f.service, "browser-2");
  await vi.waitFor(() => expect(other.client.getSnapshot().connected).toBe(true));
  await client.request({ op: "controller", deviceId, controller: "human" });
  await expect(
    other.client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: "lease_required" });
  expect(await f.helperJournal()).toEqual([]);

  await client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } });
  await client.request({ op: "input", deviceId, input: { kind: "type", text: "Hi" } });
  // Hardware keys press the Simulator window's own buttons.
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "home" } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "power" } });

  expect(await f.helperJournal()).toEqual([
    { input: { kind: "pointer.click", x: 10, y: 20, button: "left" } },
    { input: { kind: "text.type", text: "Hi" } },
    { button: "Home" },
    { button: "Sleep/Wake" },
  ]);
  await vi.waitFor(() => expect(shown).toContain("simulator:after-text.type"));
});

it("without Screen Recording the live view says which permission is missing, asks macOS for it, and starts once granted", async () => {
  const f = await fixture({ screenRecording: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });

  const refused: unknown = await client
    .request({ op: "start", deviceId, fps: 10 })
    .catch((error: unknown) => error);
  if (!(refused instanceof DeviceClientError)) throw new Error("Expected a device refusal");
  expect(refused).toMatchObject({ code: "permission_denied", permission: "screenRecording" });
  expect(refused.hint).toContain("Privacy & Security › Screen Recording");
  expect(deviceState(client)).toMatchObject({
    lifecycle: "failed",
    error: { code: "permission_denied", permission: "screenRecording" },
  });
  expect(f.logged).toContainEqual(
    expect.objectContaining({
      message: "Device request failed",
      fields: expect.objectContaining({ op: "start", permission: "screenRecording" }),
    }),
  );

  expect(
    await client.request({ op: "permissions.request", permission: "screenRecording" }),
  ).toEqual({ screenRecording: false, accessibility: true });
  expect(await f.helperJournal()).toEqual([{ requested: "screenRecording" }]);

  // The person turns on Ace Screen Helper in System Settings and tries again.
  await f.grant({ screenRecording: true, accessibility: true });
  expect(await client.request({ op: "permissions" })).toEqual({
    screenRecording: true,
    accessibility: true,
  });
  await client.request({ op: "start", deviceId, fps: 10 });
  expect(deviceState(client)).toMatchObject({ lifecycle: "live" });
  expect(deviceState(client)?.error).toBeUndefined();
});

it("a tap refused for want of Accessibility names that permission", async () => {
  const f = await fixture({ accessibility: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "controller", deviceId, controller: "human" });

  await expect(
    client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: "permission_denied", permission: "accessibility" });
  expect(await f.helperJournal()).toEqual([]);
});

it("typing while Simulator is behind another app says how to type instead of dropping the text", async () => {
  const f = await fixture({ frontmost: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "controller", deviceId, controller: "human" });

  const refused: unknown = await client
    .request({ op: "input", deviceId, input: { kind: "type", text: "hello" } })
    .catch((error: unknown) => error);
  if (!(refused instanceof DeviceClientError)) throw new Error("Expected a device refusal");
  expect(refused.code).toBe("not_supported");
  expect(refused.hint).toContain("Connect Hardware Keyboard");
  // Taps and the window's own buttons still reach a Simulator in the background.
  await client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "home" } });
  expect(await f.helperJournal()).toEqual([
    { input: { kind: "pointer.click", x: 10, y: 20, button: "left" } },
    { button: "Home" },
  ]);
});
