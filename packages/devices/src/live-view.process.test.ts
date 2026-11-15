import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { nodeBinary } from "@ace/provider-kit/testing";
import type { DeviceRuntime } from "./runtime.ts";
import { ScreenManager } from "@ace/screen";
import { ThreadId, AgentId } from "@ace/protocol";
import type { DeviceServerMessage } from "@ace/protocol/devices";
import { DeviceClient, DeviceClientError, type DeviceTransport } from "./client.ts";
import { DevicesService, DevicePlatform, reserveDevices, agentOwner } from "./index.ts";
import type { DevicePeer } from "./bridge.ts";
import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";

/*
 * The iOS Simulator live view end to end, minus macOS: a fake `xcrun simctl` keeps the
 * simulator's state in a file, a fake screen helper stands in for AceScreenHelper.app (its
 * macOS permissions in a file a test can flip), and a real DevicesService, ScreenManager,
 * devices bridge and DeviceClient sit in between, as in the daemon and the app.
 */
const udid = "22222222-2222-4222-8222-222222222222";
const deviceId = `ios:${udid}`;
function waitFor<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: PROCESS_TEST_TIMEOUT });
}

async function fixture(
  options: {
    screenRecording?: boolean;
    accessibility?: boolean;
    frontmost?: boolean;
    /** Off: the screen helper can't encode H.264, as on a Mac without serve-sim's video. */
    video?: boolean;
    pollMs?: number;
    runtime?: Pick<DeviceRuntime, "now" | "after">;
    after?: DeviceRuntime["after"];
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
    env: {
      HELPER_JOURNAL: journal,
      HELPER_PERMISSIONS: permissions,
      HELPER_WINDOW: "iPhone",
      HELPER_VIDEO: options.video === false ? "off" : "on",
    },
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    async publishArtifact() {},
  });
  const logged: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const platform = new DevicePlatform({ platform: "darwin", home, env, screen });
  const activeReads = new Set<Promise<unknown>>();
  const list = platform.list.bind(platform);
  platform.list = () => {
    const read = list();
    activeReads.add(read);
    void read.finally(() => activeReads.delete(read)).catch(() => {});
    return read;
  };
  const settleReads = () => Promise.allSettled(activeReads);
  const service = new DevicesService({
    cowork: false,
    platform,
    screen,
    runtime: {
      now: options.runtime?.now ?? Date.now,
      id: () => `device-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        if (options.runtime) return options.runtime.after(ms, run);
        if (options.after) return options.after(ms, run);
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
    settleReads,
  };
}

/** A devices client connected to the service through the bridge, as the app connects. */
function connect(
  service: DevicesService,
  owner = "browser-1",
  extra: Pick<DevicePeer, "delivery"> = {},
) {
  const sent: DeviceServerMessage[] = [];
  let channel: ReturnType<typeof reserveDevices> | undefined;
  const transport: DeviceTransport = {
    open(events) {
      // As the daemon does with a loaded service: the channel subscribes before the welcome and
      // speaks only once the welcome has gone out.
      const opened = reserveDevices(service, owner, {
        ...extra,
        authorize: () => true,
        canReadThread: () => true,
        agentExists: () => true,
        async send(message) {
          sent.push(message);
          events.message(JSON.parse(JSON.stringify(message)));
        },
        media: {
          bufferedBytes: () => 0,
          async write(piece) {
            events.message(piece);
          },
        },
      });
      channel = opened;
      queueMicrotask(() => {
        events.ready();
        opened.activate();
      });
    },
    send(message) {
      if (message.type === "devices.ack") channel?.ack(message);
      else void channel?.request(message);
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
  /** The window comes back online on a fresh channel, as after a dropped socket. */
  const reconnect = () => client.connect(transport);
  return { client, sent, reconnect };
}

const deviceState = (client: DeviceClient) =>
  client.getSnapshot().states.find((state) => state.device.id === deviceId);

it("a simulator booted from ace reads as running for every watcher, without a refresh", async () => {
  // No background reads during the test: the boot itself must bring the new state.
  const f = await fixture({ pollMs: 3_600_000 });
  const { client } = connect(f.service);
  const other = connect(f.service, "browser-2");
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await waitFor(() => expect(other.client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "controller", deviceId, controller: "human" });
  expect(deviceState(client)?.device.state).toBe("shutdown");

  await client.request({ op: "boot", deviceId });

  // The state pushed to both clients already says booted; nobody asked for the list again.
  expect(deviceState(client)?.device).toMatchObject({ state: "booted", runtime: "iOS 26.5" });
  await waitFor(() => expect(deviceState(other.client)?.device.state).toBe("booted"));
});

it("boot and shutdown answer with the state after them, not a read that started before them", async () => {
  const f = await fixture({ pollMs: 3_600_000 });
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "controller", deviceId, controller: "human" });

  // A read already in flight saw the simulator off; it answers after the boot finishes.
  await f.slowNextRead();
  const earlier = client.request({ op: "list" });
  await waitFor(async () => expect(await f.slowReadStarted()).toBe(true));
  await client.request({ op: "boot", deviceId });
  expect(deviceState(client)?.device.state).toBe("booted");
  await earlier;

  await f.slowNextRead();
  const before = client.request({ op: "list" });
  await waitFor(async () => expect(await f.slowReadStarted()).toBe(true));
  await client.request({ op: "shutdown", deviceId });
  expect(deviceState(client)?.device.state).toBe("shutdown");
  await before;
});

it("turning devices on or off reaches every open view, even one with no device sessions", async () => {
  const f = await fixture();
  const quiet = connect(f.service, "window-2");
  const first = connect(f.service, "window-1");
  await waitFor(() => expect(quiet.client.getSnapshot().connected).toBe(true));
  await waitFor(() => expect(first.client.getSnapshot().connected).toBe(true));

  await first.client.request({ op: "enable", enabled: true });
  await waitFor(() => expect(quiet.client.getSnapshot().enabled).toBe(true));
  await first.client.request({ op: "enable", enabled: false });
  await waitFor(() => expect(quiet.client.getSnapshot().enabled).toBe(false));
  await first.client.request({ op: "enable", enabled: true });
  await waitFor(() => expect(quiet.client.getSnapshot().enabled).toBe(true));
});

it("a window that was offline when devices were turned off reads them as off once it reconnects", async () => {
  const f = await fixture();
  const away = connect(f.service, "window-2");
  const first = connect(f.service, "window-1");
  await waitFor(() => expect(away.client.getSnapshot().enabled).toBe(true));
  await waitFor(() => expect(first.client.getSnapshot().connected).toBe(true));

  away.client.disconnect();
  await first.client.request({ op: "enable", enabled: false });
  away.reconnect();
  await waitFor(() => expect(away.client.getSnapshot().enabled).toBe(false));

  away.client.disconnect();
  await first.client.request({ op: "enable", enabled: true });
  away.reconnect();
  await waitFor(() => expect(away.client.getSnapshot().enabled).toBe(true));
});

it("a second view that has no device sessions yet still learns that devices are on", async () => {
  const f = await fixture();
  const first = connect(f.service, "window-1");
  await waitFor(() => expect(first.client.getSnapshot().connected).toBe(true));
  await first.client.request({ op: "enable", enabled: true });
  expect(first.client.getSnapshot().enabled).toBe(true);

  const second = connect(f.service, "window-2");
  await waitFor(() => expect(second.client.getSnapshot().connected).toBe(true));
  await second.client.request({ op: "states" });
  expect(second.client.getSnapshot()).toMatchObject({ enabled: true, states: [] });
});

it("a simulator booted or shut down outside ace shows up while a Devices view is open", async () => {
  const f = await fixture();
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "inventory.watch", watching: true });
  await client.request({ op: "list" });
  expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "shutdown" }]);

  await writeFile(f.state, "booted"); // xcrun simctl boot, from a terminal
  await waitFor(() =>
    expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "booted" }]),
  );
  await writeFile(f.state, "shutdown");
  await waitFor(() =>
    expect(client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "shutdown" }]),
  );
});

it("without an open Devices view no scheduled inventory ticks read device state", async () => {
  const pending = new Set<() => void>();
  const f = await fixture({
    pollMs: 20,
    after: (_ms, run) => {
      pending.add(run);
      return () => {
        pending.delete(run);
      };
    },
  });
  const tick = () => {
    const callbacks = Array.from(pending);
    pending.clear();
    for (const run of callbacks) run();
  };
  const observer = connect(f.service, "main");
  await waitFor(() => expect(observer.client.getSnapshot().connected).toBe(true));
  await observer.client.request({ op: "enable", enabled: true });
  await observer.client.request({ op: "list" });
  const idle = await f.readCount();
  tick();
  tick();
  // The list response is a real process-I/O barrier, without an inventory read of its own.
  await observer.client.request({ op: "states" });
  await f.settleReads();
  expect(await f.readCount()).toBe(idle);

  const view = connect(f.service, "devices-view");
  await waitFor(() => expect(view.client.getSnapshot().connected).toBe(true));
  await view.client.request({ op: "inventory.watch", watching: true });
  await writeFile(f.state, "booted");
  tick();
  await waitFor(() =>
    expect(view.client.getSnapshot().devices).toMatchObject([{ id: deviceId, state: "booted" }]),
  );
  expect(await f.readCount()).toBeGreaterThan(idle);
  // Acknowledged unsubscription prevents both future ticks and reads after the view closes.
  await view.client.request({ op: "inventory.watch", watching: false });
  view.client.disconnect();
  // A read already dispatched before disconnect can finish on a loaded host.
  await f.service.settleInventory();
  const closed = await f.readCount();
  tick();
  tick();
  await observer.client.request({ op: "states" });
  await f.settleReads();
  expect(await f.readCount()).toBe(closed);
});

it("frames from a simulator reach the client as H.264 only", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  const codecs = new Set<string>();
  client.watchPictures(deviceId, async (picture) => {
    shown.push(Buffer.from(picture.bytes).toString());
    codecs.add(picture.codec);
    client.ack(picture);
  });

  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "subscribe", deviceId });

  expect(deviceState(client)).toMatchObject({ lifecycle: "live" });
  await waitFor(() => expect(shown).toContain("simulator:home"));
  expect(codecs.size).toBe(1);
  expect(codecs.has("jpeg")).toBe(false);
});

it("a Simulator that can only make JPEG refuses the live view and names serve-sim", async () => {
  const f = await fixture({ video: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  client.watchPictures(deviceId, async (picture) => {
    shown.push(picture.codec);
    client.ack(picture);
  });
  await client.request({ op: "start", deviceId, fps: 60 });
  await expect(client.request({ op: "subscribe", deviceId })).rejects.toMatchObject({
    code: "tool_missing",
    hint: expect.stringContaining(
      "Download device tools in Devices for ace's serve-sim 0.1.49-beta.139.1",
    ),
  });
  await expect(
    client.request({
      op: "stream.configure",
      deviceId,
      settings: { codec: "h264", maxWidth: 1170, maxHeight: 2532, fps: 60, bitrate: 8000000 },
    }),
  ).rejects.toMatchObject({ code: "tool_missing" });
  // The capture keeps making JPEG for agents; none of it reaches the view.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(shown).toEqual([]);
});

it("input is refused without control and reaches the simulator with it", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  client.watchPictures(deviceId, async (picture) => {
    shown.push(Buffer.from(picture.bytes).toString());
    client.ack(picture);
  });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "subscribe", deviceId });

  await expect(
    client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: "lease_required" });
  // Another person's connection can't drive the device someone else controls.
  const other = connect(f.service, "browser-2");
  await waitFor(() => expect(other.client.getSnapshot().connected).toBe(true));
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
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "volumeUp" } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "action" } });

  expect(await f.helperJournal()).toEqual([
    { input: { kind: "pointer.click", x: 10, y: 20, button: "left" } },
    { input: { kind: "text.type", text: "Hi" } },
    { button: "Home" },
    { button: "Sleep/Wake" },
    { button: "Volume Up" },
    { button: "Action" },
  ]);
  await waitFor(() => expect(shown).toContain("simulator:after-text.type"));
});

it("without Screen Recording the live view says which permission is missing, asks macOS for it, and starts once granted", async () => {
  const f = await fixture({ screenRecording: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
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
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "controller", deviceId, controller: "human" });

  await expect(
    client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: "permission_denied", permission: "accessibility" });
  expect(await f.helperJournal()).toEqual([]);
});

it("human typing reaches Simulator behind another app without native idb", async () => {
  const f = await fixture({ frontmost: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "controller", deviceId, controller: "human" });

  await client.request({ op: "input", deviceId, input: { kind: "type", text: "hello" } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "enter" } });
  await client.request({ op: "input", deviceId, input: { kind: "tap", x: 10, y: 20 } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "home" } });
  await client.request({ op: "input", deviceId, input: { kind: "key", key: "keyboard" } });
  expect(await f.helperJournal()).toEqual([
    { input: { kind: "text.type", text: "hello" } },
    { input: { kind: "key.press", key: "Return", modifiers: [] } },
    { input: { kind: "pointer.click", x: 10, y: 20, button: "left" } },
    { button: "Home" },
    // Simulator's Toggle Software Keyboard shortcut.
    { input: { kind: "key.press", key: "K", modifiers: ["command"] } },
  ]);
});

it("agent typing cannot activate a background Simulator without native idb", async () => {
  const threadId = ThreadId.parse("thread-1");
  const agentId = AgentId.parse("agent-1");
  const f = await fixture({ frontmost: false });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({
    op: "controller",
    deviceId,
    controller: "agent",
    threadId,
    agentId,
  });
  await expect(
    f.service.request(
      { op: "input", deviceId, input: { kind: "type", text: "hello" } },
      { kind: "agent", owner: agentOwner(threadId, agentId), threadId, agentId },
    ),
  ).rejects.toMatchObject({ code: "foreground_required" });
  expect(await f.helperJournal()).toEqual([]);
});

it("lease expiry posts mouse-up at the native boundary without another client command", async () => {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const f = await fixture({
    runtime: {
      now: () => now,
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await vi.waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "start", deviceId, fps: 60 });
  await client.request({ op: "controller", deviceId, controller: "human" });
  await client.request({
    op: "input",
    deviceId,
    input: { kind: "pointer", phase: "down", x: 20, y: 20 },
  });
  now = 30000;
  for (const timer of timers)
    if (timer.at <= now) {
      timers.delete(timer);
      timer.run();
    }
  await f.screen.deviceTargets();
  expect(await f.helperJournal()).toContainEqual({
    nativeMouseUp: { windowId: 42, button: "left" },
  });
  expect(deviceState(client)?.controller).toBe("none");
});

it("a Simulator streams to a person and is handed to an agent while computer use stays off", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const { client } = connect(f.service);
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  const shown: string[] = [];
  client.watchPictures(deviceId, async (picture) => {
    shown.push(Buffer.from(picture.bytes).toString());
    client.ack(picture);
  });
  expect(await client.request({ op: "permissions" })).toEqual({
    screenRecording: true,
    accessibility: true,
  });
  await client.request({ op: "start", deviceId, fps: 10 });
  await client.request({ op: "subscribe", deviceId });
  await waitFor(() => expect(shown).toContain("simulator:home"));
  expect(deviceState(client)).toMatchObject({ lifecycle: "live" });
  expect(deviceState(client)?.threadId).toBeUndefined();
  await client.request({
    op: "controller",
    deviceId,
    controller: "agent",
    threadId: ThreadId.parse("thread-1"),
    agentId: AgentId.parse("root"),
  });
  expect(deviceState(client)).toMatchObject({
    lifecycle: "live",
    threadId: "thread-1",
    controller: "agent",
    holder: { threadId: "thread-1", agentId: "root" },
  });
  expect(f.screen.isEnabled()).toBe(false);
  expect(f.screen.states()).toMatchObject([{ controller: "agent", lifecycle: "live" }]);
});

it("a resubscribe on the same media connection that fails keeps delivering on the view it had", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const d = fakeDelivery();
  const failing = { on: false };
  const sent: DeviceServerMessage[] = [];
  const channel = reserveDevices(f.service, "browser-1", {
    authorize: () => true,
    canReadThread: () => true,
    agentExists: () => true,
    async send(message) {
      sent.push(message);
    },
    media: { bufferedBytes: () => 0, async write() {} },
    delivery: {
      owner: () => phoneOwner,
      // The view's first picture for the answer: failing here fails the subscribe after its
      // view was granted.
      port: () => ({
        ...d.port,
        poster: () =>
          failing.on ? Promise.reject(new Error("poster gone")) : Promise.resolve(undefined),
      }),
    },
  });
  onTestFinished(() => channel.close());
  channel.activate();
  const request = async (requestId: string, operation: Record<string, unknown>) => {
    await channel.request({ type: "devices.request", requestId, operation });
    const result = sent.findLast((m) => m.type === "devices.result" && m.requestId === requestId);
    if (!result) throw new Error(`no answer to ${requestId}`);
    return result;
  };
  await request("enable", { op: "enable", enabled: true });
  await request("list", { op: "list" });
  await request("start", { op: "start", deviceId, fps: 10 });
  const media = { connection: "mc_aaaaaaaaaaaa" };
  expect(await request("first", { op: "subscribe", deviceId, media })).toMatchObject({ ok: true });
  const [first] = d.live;
  expect(first).toBeDefined();
  failing.on = true;
  expect(await request("again", { op: "subscribe", deviceId, media })).toMatchObject({ ok: false });
  failing.on = false;
  // Its new view replaced the old one in ace-media, then was undone: the old one delivers again.
  expect([...d.live]).toEqual([first]);
  expect(d.views.size).toBe(1);
  // The subscription still holds it: leaving closes it.
  await request("leave", { op: "unsubscribe", deviceId });
  expect(d.live.size).toBe(0);
  expect(d.views.size).toBe(0);
});

it("a media resubscribe that fails leaves the legacy view its stream and its pictures", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const d = fakeDelivery();
  const failing = { on: false };
  const { client } = connect(f.service, "browser-1", {
    delivery: {
      owner: () => phoneOwner,
      port: () => ({
        ...d.port,
        poster: () =>
          failing.on ? Promise.reject(new Error("poster gone")) : Promise.resolve(undefined),
      }),
    },
  });
  await waitFor(() => expect(client.getSnapshot().connected).toBe(true));
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  let shown = 0;
  client.watchPictures(deviceId, async (picture) => {
    shown++;
    client.ack(picture);
  });
  await client.request({ op: "start", deviceId, fps: 10 });
  // Watched on the main socket: the daemon delivers it.
  await client.request({ op: "subscribe", deviceId });
  await waitFor(() => expect(shown).toBeGreaterThan(0));
  failing.on = true;
  await expect(
    client.request({ op: "subscribe", deviceId, media: { connection: "mc_aaaaaaaaaaaa" } }),
  ).rejects.toThrow();
  failing.on = false;
  expect(d.views.size).toBe(0);
  // The old view keeps its stream request: the device still makes H.264, so the next picture
  // reaches it. (A withdrawn request would leave the device on JPEG, which live views drop.)
  const before = shown;
  await client.request({ op: "stream.keyframe", deviceId });
  await vi.waitFor(() => expect(shown).toBeGreaterThan(before), { timeout: 2_000 });
});
