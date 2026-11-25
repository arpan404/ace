// SPDX-License-Identifier: Apache-2.0

/**
 * The real binding (D3.1): with `ACE_DEVICE_PLATFORM=native` these call the built addon through
 * the same helpers the platform uses and assert the plans it returns, so a signature the mocked
 * dispatch tests cannot see (a renamed export, a changed envelope) fails here.
 *
 * Run with the switch on: `ACE_DEVICE_PLATFORM=native ACE_SUPERVISOR=native bun --bun x vitest
 * run packages/devices/src/native-platform.addon.test.ts`.
 */
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { describe, expect, test } from "vitest";
import {
  type AndroidBoot,
  type DeviceRecord,
  type IosBoot,
  type ListAnswer,
  type OpenAppPlan,
  type Selected,
  type Step,
  type ToolsPlan,
  answered,
  nativeDevices,
} from "./native-devices-addon.ts";
import { NativeDevicePlatform } from "./native-platform.ts";

const UDID = "11111111-1111-4111-8111-111111111111";

const addon = () => nativeDevices();

describe.runIf(devicePlatformBackend() === "native")("the built addon's plans", () => {
  test("identity turns the listed Simulator into the device the platform returns", () => {
    const inventory = [
      {
        udid: UDID,
        name: "iPhone 18 Pro",
        state: "Booted",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
      },
    ];
    const selected = answered<Selected>(() =>
      addon().devicePlatformIdentity(`ios:${UDID}`, false, JSON.stringify(inventory)),
    );
    expect(selected).toEqual({ name: "iPhone 18 Pro", state: "booted", runtime: "iOS 18.0" });
  });

  test("list composes the sources and keeps a missing SDK as a diagnostic", () => {
    const answer = answered<ListAnswer>(() =>
      addon().devicePlatformList(
        JSON.stringify([
          {
            platform: "ios",
            devices: [],
            failure: { code: "sdk_missing", message: "no Xcode", hint: "install it" },
          },
          {
            platform: "android",
            devices: [
              {
                id: "android:Pixel_API_35",
                platform: "android",
                name: "Pixel_API_35",
                state: "booted",
              },
            ],
          },
        ]),
      ),
    );
    expect(answer.devices.map((device) => device.id)).toEqual(["android:Pixel_API_35"]);
    expect(answer.missing).toEqual([
      { code: "sdk_missing", message: "no Xcode", hint: "install it", platform: "ios" },
    ]);
  });

  test("boot decides the Simulator's window and the emulator's port and waits", () => {
    const boot = answered<IosBoot>(() => addon().devicePlatformIosBoot(`ios:${UDID}`, false));
    expect(boot.boot).toBe(true);
    expect(boot.show).toContain("-CurrentDeviceUDID");
    const android = answered<AndroidBoot>(() =>
      addon().devicePlatformAndroidBoot(
        JSON.stringify({
          avd: "Pixel_API_35",
          used_serials: ["emulator-5554"],
          taken_ports: [],
          running: 0,
          pending: false,
          closed: false,
          emulator_found: true,
          platform: "darwin",
          arch: "arm64",
          window: false,
        }),
      ),
    );
    expect(android).toMatchObject({ port: 5556, serial: "emulator-5556" });
    expect(android.args.slice(0, 2)).toEqual(["-avd", "Pixel_API_35"]);
    expect(android.steps[1]?.args[0]).toBe("shell");
  });

  test("shutdown keeps today's commands", () => {
    const steps = answered<Step[]>(() => addon().devicePlatformShutdown("android"));
    expect(steps[0]?.args).toEqual(["emu", "kill"]);
    expect(steps[1]?.args).toEqual(["shell", "reboot", "-p"]);
  });

  test("the package lifecycle plans install, launch and configure", () => {
    const install = answered<Step[]>(() => addon().devicePlatformInstall("ios", "/tmp/A.app"));
    expect(install[0]?.args).toEqual(["install", "/tmp/A.app"]);
    expect(install[0]?.timeoutMs).toBe(600_000);
    const open = answered<OpenAppPlan>(() =>
      addon().devicePlatformOpenApp("android", "dev.example"),
    );
    expect(open.steps).toEqual([]);
    expect(open.resolve?.args.join(" ")).toContain("resolve-activity");
    const configure = answered<Step[]>(() =>
      addon().devicePlatformConfigure("ios", '{"appearance":"dark"}', false),
    );
    expect(configure[0]?.args).toEqual(["ui", "appearance", "dark"]);
  });

  test("the tools plan and wm size decode keep today's numbers", () => {
    const plan = answered<ToolsPlan>(() =>
      addon().devicePlatformDownloadPlan("darwin", "/tmp/tools", "/bin/node"),
    );
    expect(plan).toEqual({ serveSim: true, scrcpy: true, timeoutMs: 300_000 });
    const size = answered<{ width: number; height: number }>(() =>
      addon().devicePlatformAndroidDimensions("Physical size: 1080x1920\n"),
    );
    expect(size).toEqual({ width: 1080, height: 1920 });
  });

  test("emulator discovery answers only for the matching console port", () => {
    const match = answered<{ matched: boolean; grpc: { port: number; token: string } | null }>(() =>
      addon().devicePlatformEmulatorGrpcFile(
        "emulator-5554",
        "pid_1.ini",
        "port.serial=5554\ngrpc.port=8554\ngrpc.token=secret",
      ),
    );
    expect(match).toEqual({ matched: true, grpc: { port: 8554, token: "secret" } });
    const other = answered<{ matched: boolean }>(() =>
      addon().devicePlatformEmulatorGrpcFile(
        "emulator-5554",
        "pid_2.ini",
        "port.serial=5556\ngrpc.port=8556\ngrpc.token=other",
      ),
    );
    expect(other.matched).toBe(false);
  });

  test("the facade's list runs the real record and composition exports", async () => {
    const platform = new NativeDevicePlatform({
      platform: "darwin",
      home: "/home/a",
      env: {},
      node: "/node",
    });
    const internals = platform as unknown as {
      simulators: { list: () => Promise<Record<string, unknown>[]> };
      android: { list: () => Promise<unknown[]> };
    };
    internals.simulators = {
      list: async () => [
        {
          udid: UDID,
          name: "iPhone 18 Pro",
          state: "Booted",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        },
      ],
    };
    internals.android = { list: async () => [] };
    const devices = await platform.list();
    expect(devices.map((device) => device.id)).toEqual([`ios:${UDID}`]);
  });

  test("records keep a name's lone surrogate", () => {
    const record = answered<DeviceRecord>(() =>
      addon().devicePlatformSimulatorRecord(
        JSON.stringify({
          udid: UDID,
          name: "iPhone \ud800 Pro",
          state: "Booted",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        }),
      ),
    );
    expect(record.name).toBe("iPhone \ud800 Pro");
  });
});
