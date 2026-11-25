// SPDX-License-Identifier: Apache-2.0

/**
 * The dispatch itself (D3.1): with `ACE_DEVICE_PLATFORM=native` the facade asks the addon for
 * the plan and runs the steps it names through the inherited platform, and an addon refusal
 * becomes the `DeviceError` it names. No SDK command runs.
 */
import { expect, test, vi } from "vitest";

const addon = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  answers: {} as Record<string, string>,
  pid: null as string | null,
}));

/** One addon export: records its arguments and answers what the test set for it. */
function answer(name: string) {
  return (...args: unknown[]) => {
    addon.calls.push({ name, args });
    return addon.answers[name] ?? '{"ok":true,"value":null}';
  };
}

vi.mock("./native-devices-addon.ts", () => {
  class Refused extends Error {
    readonly refusal: { code: string; message: string; hint: string };
    constructor(refusal: { code: string; message: string; hint: string }) {
      super(refusal.message);
      this.refusal = refusal;
    }
  }
  return {
    Refused,
    envStrings: (env: Record<string, string | undefined>) => env,
    nativeDevices: () => ({
      devicePlatformDownloadPlan: answer("devicePlatformDownloadPlan"),
      devicePlatformList: answer("devicePlatformList"),
      devicePlatformSimulatorRecord: answer("devicePlatformSimulatorRecord"),
      devicePlatformIosBoot: answer("devicePlatformIosBoot"),
      devicePlatformShutdown: answer("devicePlatformShutdown"),
      devicePlatformInstall: answer("devicePlatformInstall"),
      devicePlatformOpenApp: answer("devicePlatformOpenApp"),
      devicePlatformConfigure: answer("devicePlatformConfigure"),
      devicePlatformLaunchPid: () => addon.pid,
    }),
    answered: (invoke: () => string) => {
      const parsed = JSON.parse(invoke()) as {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string; hint: string };
      };
      if (!parsed.ok || parsed.error) {
        if (!parsed.error) throw new Error("refused without a word");
        throw new Refused(parsed.error);
      }
      return parsed.value;
    },
  };
});

const { NativeDevicePlatform } = await import("./native-platform.ts");
const { DeviceError } = await import("./sdk.ts");

const UDID = "11111111-1111-4111-8111-111111111111";
const DEVICE = {
  id: `ios:${UDID}`,
  platform: "ios",
  name: "iPhone 18 Pro",
  state: "booted",
} as const;

type Wiring = {
  simulators: { list: () => Promise<Record<string, unknown>[]> };
  android: Record<string, (...args: never[]) => unknown>;
  simctl: (device: unknown, args: readonly string[]) => Promise<{ code: number; stdout: string }>;
  run: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>;
  xcode: () => Promise<{ xcrun: string; open: string }>;
  appProcesses: Map<string, string>;
  toolsPlan(): { serveSim: boolean; scrcpy: boolean; timeoutMs: number };
};

function platform() {
  return new NativeDevicePlatform({ platform: "darwin", home: "/home/a", env: {}, node: "/node" });
}

function wiring(instance: InstanceType<typeof NativeDevicePlatform>): Wiring {
  return instance as unknown as Wiring;
}

function value(payload: unknown) {
  return JSON.stringify({ ok: true, value: payload });
}

function ran(instance: InstanceType<typeof NativeDevicePlatform>): unknown[][] {
  const calls = wiring(instance);
  const steps: unknown[][] = [];
  calls.simctl = async (_device, args) => {
    steps.push(["simctl", ...args]);
    return { code: 0, stdout: "" };
  };
  calls.run = async (command, args) => {
    steps.push(["run", command, ...args]);
    return { code: 0, stdout: "" };
  };
  calls.xcode = async () => ({ xcrun: "/xcrun", open: "/open" });
  return steps;
}

test("the native platform's tools plan is the addon's, with today's wants and budget", () => {
  addon.calls.length = 0;
  addon.answers["devicePlatformDownloadPlan"] = value({
    serveSim: true,
    scrcpy: true,
    timeoutMs: 300_000,
  });
  const plan = wiring(platform()).toolsPlan();
  expect(plan).toEqual({ serveSim: true, scrcpy: true, timeoutMs: 300_000 });
  expect(addon.calls).toEqual([
    { name: "devicePlatformDownloadPlan", args: ["darwin", undefined, "/node"] },
  ]);
});

test("an addon refusal is the DeviceError the platform raises", () => {
  addon.calls.length = 0;
  addon.answers["devicePlatformDownloadPlan"] =
    '{"ok":false,"error":{"code":"tool_missing","message":"ace has nowhere to keep device tools","hint":"Restart ace; its home directory should hold them."}}';
  expect(() => wiring(platform()).toolsPlan()).toThrow(DeviceError);
  expect(() => wiring(platform()).toolsPlan()).toThrow("ace has nowhere to keep device tools");
  addon.answers["devicePlatformDownloadPlan"] = value({
    serveSim: true,
    scrcpy: true,
    timeoutMs: 300_000,
  });
});

test("every platform probe is given the injected scheduler", async () => {
  const waited: number[] = [];
  let schedule: ((run: () => void, ms: number) => void) | undefined;
  const instance = new NativeDevicePlatform({
    platform: "darwin",
    home: "/home/a",
    env: {},
    after: (ms, run) => {
      waited.push(ms);
      run();
      return () => {};
    },
    probe: async (_command, _args, options) => {
      schedule = options?.schedule;
      return { stdout: '{"devices":{}}', stderr: "", code: 0 };
    },
  });
  const calls = wiring(instance);
  calls.xcode = async () => ({ xcrun: "/xcrun", open: "/open" });
  await calls.simulators.list();
  expect(schedule).toBeTypeOf("function");
  let fired = false;
  schedule?.(() => {
    fired = true;
  }, 7);
  expect(waited).toEqual([7]);
  expect(fired).toBe(true);
});

test("list asks the addon for each Simulator and for the composition", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const calls = wiring(instance);
  calls.simulators = {
    list: async () => [
      {
        udid: UDID,
        name: "iPhone \ud800 Pro",
        state: "Booted",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
    ],
  };
  calls.android = { list: async () => [{ id: "android:Pixel_API_35", name: "Pixel_API_35" }] };
  addon.answers["devicePlatformSimulatorRecord"] = value(DEVICE);
  addon.answers["devicePlatformList"] = value({
    devices: [
      DEVICE,
      { id: "android:Pixel_API_35", platform: "android", name: "Pixel_API_35", state: "booted" },
    ],
    missing: [],
  });
  const devices = await instance.list();
  expect(devices.map((device) => device.id)).toEqual([`ios:${UDID}`, "android:Pixel_API_35"]);
  const record = addon.calls.find((call) => call.name === "devicePlatformSimulatorRecord");
  expect(JSON.parse(String(record?.args[0]))).toMatchObject({
    udid: UDID,
    name: "iPhone \ud800 Pro",
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  });
  const composed = addon.calls.find((call) => call.name === "devicePlatformList");
  expect(JSON.parse(String(composed?.args[0]))).toMatchObject([
    { platform: "ios", devices: [DEVICE] },
    { platform: "android", devices: [{ id: "android:Pixel_API_35" }] },
  ]);
});

test("a Simulator boot follows the addon's plan: boot when needed, then show it", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const calls = wiring(instance);
  const steps = ran(instance);
  calls.simulators = { list: async () => [{ udid: UDID, name: "iPhone", state: "Shutdown" }] };
  const show = ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", UDID];
  addon.answers["devicePlatformIosBoot"] = value({ boot: true, show });
  await instance.boot({ ...DEVICE, state: "shutdown", name: "iPhone" });
  expect(addon.calls[0]).toEqual({ name: "devicePlatformIosBoot", args: [`ios:${UDID}`, false] });
  expect(steps).toEqual([
    ["simctl", "boot"],
    ["run", "/open", ...show],
  ]);
});

test("a Simulator shutdown runs exactly the addon's steps", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const steps = ran(instance);
  addon.answers["devicePlatformShutdown"] = value([{ kind: "simctl", args: ["shutdown", UDID] }]);
  await instance.shutdown(DEVICE);
  expect(addon.calls).toEqual([{ name: "devicePlatformShutdown", args: ["ios"] }]);
  expect(steps).toEqual([["simctl", "shutdown", UDID]]);
});

test("an install keeps the addon's command, byte cap and ten-minute budget", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const calls = wiring(instance);
  const asked: unknown[] = [];
  calls.simctl = async (_device, args, ...rest) => {
    asked.push([args, rest]);
    return { code: 0, stdout: "" };
  };
  addon.answers["devicePlatformInstall"] = value([
    { kind: "simctl", args: ["install", "/tmp/Example.app"], timeoutMs: 600_000 },
  ]);
  await instance.install(DEVICE, "/tmp/Example.app");
  expect(addon.calls).toEqual([
    { name: "devicePlatformInstall", args: ["ios", "/tmp/Example.app"] },
  ]);
  expect(asked).toEqual([
    [
      ["install", "/tmp/Example.app"],
      [undefined, 600_000],
    ],
  ]);
});

test("opening a Simulator app runs the launch and keeps the process it names", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const calls = wiring(instance);
  calls.simctl = async () => ({ code: 0, stdout: "dev.example: 4242" });
  addon.pid = "4242";
  addon.answers["devicePlatformOpenApp"] = value({
    steps: [{ kind: "simctl", args: ["launch", "dev.example"] }],
  });
  await instance.openApp(DEVICE, "dev.example");
  expect(addon.calls).toEqual([{ name: "devicePlatformOpenApp", args: ["ios", "dev.example"] }]);
  expect(calls.appProcesses.get(DEVICE.id)).toBe("4242");
  addon.pid = null;
});

test("configure sends the schema's settings, in the addon's order", async () => {
  addon.calls.length = 0;
  const instance = platform();
  const calls = wiring(instance);
  const steps = ran(instance);
  calls.android = { physical: () => false };
  const settings = { appearance: "dark" } as const;
  addon.answers["devicePlatformConfigure"] = value([
    { kind: "simctl", args: ["ui", UDID, "appearance", "dark"] },
  ]);
  await instance.configure(DEVICE, settings);
  expect(addon.calls).toEqual([
    { name: "devicePlatformConfigure", args: ["ios", JSON.stringify(settings), false] },
  ]);
  expect(steps).toEqual([["simctl", "ui", UDID, "appearance", "dark"]]);
});
