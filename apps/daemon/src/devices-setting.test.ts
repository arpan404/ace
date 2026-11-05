import { DevicePlatform, DevicesService } from "@ace/devices";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SettingsService } from "@ace/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { followDevicesSetting } from "./devices-setting.ts";
import { LazyDevices } from "./lazy-devices.ts";

type DevicesOptions = ConstructorParameters<typeof DevicesService>[0];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A log process whose stop waits on `stopped`, so turning devices off can be held mid-cleanup. */
function heldLogs() {
  const { promise: stopped, resolve: release } = Promise.withResolvers<void>();
  const exit = { reason: "stopped" as const, code: 0, signal: null };
  const spawn = (() => ({
    stdin: new PassThrough(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exited: new Promise(() => {}),
    signal: new AbortController().signal,
    stop: async () => (await stopped, exit),
  })) as unknown as NonNullable<DevicesOptions["spawnLogs"]>;
  return { spawn, release };
}

const deviceId = "android:emulator-5554";

function devicesService(enabled: boolean, spawnLogs?: DevicesOptions["spawnLogs"]) {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: deviceId, platform: "android", name: "Pixel", state: "booted", serial: "emulator-5554" },
  ];
  platform.logs = async () => ({ command: "adb", args: ["logcat"] });
  return new DevicesService({
    enabled,
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    ...(spawnLogs ? { spawnLogs } : {}),
    runtime: {
      now: () => 0,
      id: () => "device",
      after: () => () => {},
      spawn() {
        throw new Error("No native effect expected");
      },
    },
  });
}

async function setup(
  saved?: boolean,
  options: { build?: Promise<void>; spawnLogs?: DevicesOptions["spawnLogs"] } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-devices-setting-"));
  const settings = new SettingsService({ dataDir });
  if (saved !== undefined) await settings.set("devices.enabled", saved, { kind: "global" });
  const built: boolean[] = [];
  const devices = new LazyDevices(async (enabled) => {
    built.push(enabled);
    await options.build;
    return devicesService(enabled, options.spawnLogs);
  });
  const stop = await followDevicesSetting(
    devices,
    settings,
    (error) => {
      throw error;
    },
    () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  cleanups.push(async () => {
    stop();
    await devices.close();
    await settings.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { settings, devices, built };
}

const saved = async (settings: SettingsService) => (await settings.get("devices.enabled")).value;

test("devices stay off across a restart once turned off in Settings", async () => {
  const { devices, built } = await setup(false);
  expect(devices.isEnabled()).toBe(false);
  const service = await devices.load();
  expect(built).toEqual([false]);
  expect(service.isEnabled()).toBe(false);
});

test("devices are on when the setting was never saved", async () => {
  const { devices } = await setup();
  expect(devices.isEnabled()).toBe(true);
  expect((await devices.load()).isEnabled()).toBe(true);
});

test("turning devices off in Settings tells every watcher, before and after they load", async () => {
  const { settings, devices } = await setup();
  const heard: boolean[] = [];
  devices.watchEnabled((enabled) => heard.push(enabled));
  await settings.set("devices.enabled", false, { kind: "global" });
  await vi.waitFor(() => expect(devices.isEnabled()).toBe(false));
  await devices.load();
  await settings.set("devices.enabled", true, { kind: "global" });
  await vi.waitFor(() => expect(devices.isEnabled()).toBe(true));
  expect(heard).toEqual([false, true]);
});

test("turning devices on from a thread's Devices tab is saved", async () => {
  const { settings, devices } = await setup(false);
  await devices.request({ op: "enable", enabled: true }, { kind: "human", owner: "viewer" });
  await vi.waitFor(async () => expect(await saved(settings)).toBe(true));
});

test("turning devices off in Settings while they are still loading leaves them off", async () => {
  const { promise: build, resolve: finishBuild } = Promise.withResolvers<void>();
  const { settings, devices, built } = await setup(undefined, { build });
  const loading = devices.load();
  await vi.waitFor(() => expect(built).toEqual([true]));
  await settings.set("devices.enabled", false, { kind: "global" });
  await vi.waitFor(() => expect(devices.isEnabled()).toBe(false));
  finishBuild();
  expect((await loading).isEnabled()).toBe(false);
  expect(devices.isEnabled()).toBe(false);
  expect(await saved(settings)).toBe(false);
});

test("turning devices back on in Settings while they are still shutting down leaves them on", async () => {
  const logs = heldLogs();
  const { settings, devices } = await setup(undefined, { spawnLogs: logs.spawn });
  const viewer = { kind: "human", owner: "viewer" } as const;
  await devices.request({ op: "logs.start", deviceId }, viewer);
  const disabling = devices.request({ op: "enable", enabled: false }, viewer);
  await vi.waitFor(async () => expect(await saved(settings)).toBe(false));
  await settings.set("devices.enabled", true, { kind: "global" });
  logs.release();
  await disabling;
  await vi.waitFor(() => expect(devices.isEnabled()).toBe(true));
  expect(await saved(settings)).toBe(true);
});

test("turning devices on then straight off from a Devices tab ends off, live and saved", async () => {
  const { settings, devices } = await setup(false);
  const service = await devices.load();
  const viewer = { kind: "human", owner: "viewer" } as const;
  await service.request({ op: "enable", enabled: true }, viewer);
  await service.request({ op: "enable", enabled: false }, viewer);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(devices.isEnabled()).toBe(false);
  expect(await saved(settings)).toBe(false);
});
