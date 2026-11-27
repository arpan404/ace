// SPDX-License-Identifier: Apache-2.0

/**
 * The real binding (D3.1): with `ACE_DEVICE_PLATFORM=native` these call the built addon through
 * the same helpers the platform uses and assert the plans it returns, so a signature the mocked
 * dispatch tests cannot see (a renamed export, a changed envelope) fails here.
 *
 * Run with the switch on: `ACE_DEVICE_PLATFORM=native ACE_SUPERVISOR=native bun --bun x vitest
 * run packages/devices/src/native-platform.addon.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { describe, expect, onTestFinished, test } from "vitest";
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
import { serveSimArtifacts } from "./serve-sim-install.ts";

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

  test("a managed serve-sim is found only with the pinned marker and script", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-managed-serve-sim-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    expect(
      answered<{ command: string; args: string[] } | null>(() =>
        addon().devicePlatformManagedServeSim(root, "/bin/node"),
      ),
    ).toBeNull();
    const install = join(root, `serve-sim-${serveSimArtifacts.serveSim.version}`);
    await mkdir(join(install, "dist"), { recursive: true });
    await writeFile(join(install, "dist", "serve-sim.js"), "script");
    await writeFile(
      join(install, ".ace-install.json"),
      JSON.stringify({
        serveSim: serveSimArtifacts.serveSim.integrity,
        ws: serveSimArtifacts.ws.integrity,
      }),
    );
    const command = answered<{ command: string; args: string[] } | null>(() =>
      addon().devicePlatformManagedServeSim(root, "/bin/node"),
    );
    expect(command?.command).toBe("/bin/node");
    expect(command?.args[0]).toBe(join(install, "dist", "serve-sim.js"));
  });

  test("simctl's list parses into the available Simulators", () => {
    const listed = answered<Record<string, unknown>[]>(() =>
      addon().devicePlatformSimulatorList(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              {
                udid: UDID,
                name: "iPhone \ud800 Pro",
                state: "Booted",
                isAvailable: true,
                deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
              },
              {
                udid: "22222222-2222-4222-8222-222222222222",
                name: "Gone",
                state: "Shutdown",
                isAvailable: false,
              },
            ],
          },
        }),
      ),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "iPhone \ud800 Pro",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
      isAvailable: true,
    });
  });

  test("a serve-sim version is parsed and accepted by the pinned list", () => {
    expect(addon().devicePlatformServeSimVersion(0, "v0.1.49-beta.139.1\n")).toBe(
      "0.1.49-beta.139.1",
    );
    expect(addon().devicePlatformServeSimVersion(1, "v0.1.49-beta.139.1\n")).toBeNull();
    expect(addon().devicePlatformServeSimVersion(0, "serve-sim 0.1.49")).toBeNull();
    expect(addon().devicePlatformServeSimSupported("0.1.49-beta.139.1")).toBe(true);
    expect(addon().devicePlatformServeSimSupported("0.1.48")).toBe(false);
    expect(addon().devicePlatformServeSimSupported(null)).toBe(false);
  });

  test("a helper of ace's older copy is the one replaced", () => {
    expect(
      addon().devicePlatformReplacesHelper(
        "/usr/bin/node /home/a/.ace/tools/serve-sim-0.1.48/dist/serve-sim.js -l ABCD",
        "0.1.49-beta.139.1",
      ),
    ).toBe(true);
    expect(
      addon().devicePlatformReplacesHelper("/usr/local/bin/serve-sim -l ABCD", "0.1.49-beta.139.1"),
    ).toBe(false);
  });

  test("with both switches on the facade keeps D2's scoped listing", async () => {
    const platform = new NativeDevicePlatform({
      platform: "darwin",
      home: "/home/a",
      env: {},
      node: "/node",
    });
    const internals = platform as unknown as {
      simulators: { list: () => Promise<Record<string, unknown>[]> };
      android: { list: (scope?: string) => Promise<unknown[]> };
    };
    const scopes: string[] = [];
    internals.simulators = {
      list: async () => [
        {
          udid: UDID,
          name: "iPhone 18 Pro",
          state: "Booted",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        },
      ],
    };
    internals.android = {
      list: async (scope = "all") => {
        scopes.push(scope);
        return [];
      },
    };
    expect(platform.scopedListing()).toBe(true);
    expect((await platform.list()).map((device) => device.id)).toEqual([`ios:${UDID}`]);
    expect(scopes).toEqual(["all"]);
    expect((await platform.listSource("ios")).map((device) => device.id)).toEqual([`ios:${UDID}`]);
    expect(scopes).toEqual(["all"]);
    expect((await platform.listSource("adb")).map((device) => device.id)).toEqual([`ios:${UDID}`]);
    expect(scopes).toEqual(["all", "adb"]);
  });

  test("the addon's async install fetches, checks and unpacks a local fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-addon-install-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const packageTar = (name: string, files: [string, string][]) => {
      const source = join(root, name);
      for (const [path, body] of files) {
        const full = join(source, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
      }
      const archive = join(root, `${name}.tgz`);
      execFileSync("/usr/bin/tar", ["-czf", archive, "-C", source, "package"]);
      const bytes = readFileSync(archive);
      return {
        bytes,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      };
    };
    const serveSim = packageTar("serve-sim", [["package/dist/serve-sim.js", "script"]]);
    const ws = packageTar("ws", [["package/index.js", "ws"]]);
    const bodies = new Map<string, Buffer>([
      ["/serve-sim.tgz", serveSim.bytes],
      ["/ws.tgz", ws.bytes],
    ]);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requests.push(path);
      const body = bodies.get(path);
      if (!body) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": body.length });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const text = await addon().devicePlatformInstallTools(
      JSON.stringify({
        directory: join(root, "tools"),
        node: "/bin/node",
        serveSim: true,
        scrcpy: false,
        id: "addon-test",
        timeoutMs: 30_000,
        artifacts: {
          serveSim: {
            name: "serve-sim",
            version: "0.1.49-beta.139.1",
            url: `http://127.0.0.1:${port}/serve-sim.tgz`,
            integrity: serveSim.integrity,
          },
          ws: {
            name: "ws",
            version: "8.22.0",
            url: `http://127.0.0.1:${port}/ws.tgz`,
            integrity: ws.integrity,
          },
        },
      }),
    );
    const installed = answered<{ serveSim: { command: string; args: string[] } }>(() => text);
    expect(installed.serveSim.command).toBe("/bin/node");
    expect(installed.serveSim.args[0]?.endsWith("dist/serve-sim.js")).toBe(true);
    expect(existsSync(installed.serveSim.args[0] ?? "")).toBe(true);
    expect(requests.toSorted()).toEqual(["/serve-sim.tgz", "/ws.tgz"]);

    const jar = join(root, "scrcpy-server");
    writeFileSync(jar, "server");
    const override = await addon().devicePlatformInstallTools(
      JSON.stringify({
        directory: join(root, "tools"),
        node: "/bin/node",
        serveSim: false,
        scrcpy: true,
        id: "override",
        timeoutMs: 5000,
        scrcpyServer: jar,
        scrcpyRelease: {
          version: "9.9.9",
          bytes: 6,
          sha256: createHash("sha256").update("server").digest("hex"),
          url: "http://127.0.0.1:1/never",
        },
      }),
    );
    expect(answered<{ scrcpy: string }>(() => override).scrcpy).toBe(jar);
    expect(requests).toHaveLength(2);
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
