import { DevicePlatform, DevicesService } from "@ace/devices";
import { SettingsService } from "@ace/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { followDevicesSetting } from "./devices-setting.ts";
import { LazyDevices } from "./lazy-devices.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function devicesService(enabled: boolean) {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [];
  return new DevicesService({
    enabled,
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
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

async function setup(saved?: boolean) {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-devices-setting-"));
  const settings = new SettingsService({ dataDir });
  if (saved !== undefined) await settings.set("devices.enabled", saved, { kind: "global" });
  const built: boolean[] = [];
  const devices = new LazyDevices(async (enabled) => {
    built.push(enabled);
    return devicesService(enabled);
  });
  const stop = await followDevicesSetting(devices, settings, (error) => {
    throw error;
  });
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
