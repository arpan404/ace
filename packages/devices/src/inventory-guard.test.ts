import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { deviceInventoryBackend } from "@ace/provider-kit/native-switches";
import type { ProcessExit, SupervisedProcess } from "@ace/provider-kit/process";
import { AndroidPlatform } from "./android-platform.ts";
import { DevicePlatform, DevicesService } from "./index.ts";

async function fakeSdkDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-devices-guard-unit-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const rel of ["platform-tools/adb", "emulator/emulator"]) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), "#!/bin/sh\nexit 1\n");
    await chmod(join(root, rel), 0o700);
  }
  return root;
}

function fakeProcess(): SupervisedProcess {
  const controller = new AbortController();
  const exited = Promise.withResolvers<ProcessExit>();
  const out = new PassThrough();
  const err = new PassThrough();
  const stdout = createInterface({ input: out });
  const stderr = createInterface({ input: err });
  const stdin = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  return {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    exited: exited.promise,
    signal: controller.signal,
    stop() {
      controller.abort();
      stdout.close();
      stderr.close();
      out.end();
      err.end();
      const result: ProcessExit = { code: 0, signal: null, reason: "stopped" };
      exited.resolve(result);
      return exited.promise;
    },
  };
}

describe.runIf(deviceInventoryBackend() !== "native")("inventory switch-off base parity", () => {
  it("DevicePlatform.list resolves in the exact base microtask without an extra async hop", async () => {
    const root = await fakeSdkDir();
    const adbGate = Promise.withResolvers<{ stdout: string; stderr: string; code: number }>();
    const adbEntered = Promise.withResolvers<void>();
    const platform = new DevicePlatform({
      platform: "linux",
      home: root,
      env: { ANDROID_HOME: root },
      probe(_command, args) {
        const cmd = args.join(" ");
        if (cmd === "-list-avds")
          return Promise.resolve({ stdout: "Pixel\n", stderr: "", code: 0 });
        if (cmd === "devices -l") {
          adbEntered.resolve();
          return adbGate.promise;
        }
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    });

    const listPromise = platform.list();
    await adbEntered.promise;

    const order: string[] = [];
    // Baseline mirrors base DevicePlatform.list(): async run() -> android.list() -> Promise.allSettled then sync return.
    const runStage = (async () => await adbGate.promise)();
    const androidStage = (async () => {
      await Promise.all([Promise.resolve(), runStage]);
      await Promise.all([Promise.all([]), Promise.all([])]);
      return [] as unknown[];
    })();
    const baseline = (async () => {
      await Promise.allSettled([androidStage]);
      return [];
    })();

    void listPromise.then(() => order.push("platform.list"));
    void baseline
      .then(() => order.push("baseline"))
      .then(() => order.push("baseline+1"))
      .then(() => order.push("baseline+2"));

    adbGate.resolve({ stdout: "List of devices attached\n", stderr: "", code: 0 });
    await Promise.all([listPromise, baseline]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Base platform.list resolves on the exact same microtask turn as baseline (before baseline+1).
    expect(order.indexOf("platform.list")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("platform.list")).toBeLessThan(order.indexOf("baseline+1"));
  });

  it("DevicesService.freshList calls list() overrides and preserves base promise ordering", async () => {
    const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
    platform.list = async () => [
      { id: "android:Pixel", name: "Pixel", platform: "android", state: "booted" },
    ];
    platform.shutdown = async () => {};

    const service = new DevicesService({
      cowork: false,
      platform,
      env: {},
      recordingDirectory: "/unused",
      publishArtifact: async () => {},
      runtime: {
        now: () => 1000,
        id: () => "unused",
        after: () => () => {},
        spawn() {
          throw new Error("Unexpected spawn");
        },
      },
    });
    onTestFinished(() => service.close());

    await service.list();
    let listOverrideCalls = 0;
    const baseList = service.list.bind(service);
    service.list = async () => {
      listOverrideCalls++;
      return baseList();
    };

    const actor = { kind: "human" as const, owner: "conn-1" };
    await service.request(
      { op: "controller", deviceId: "android:Pixel", controller: "human" },
      actor,
    );
    listOverrideCalls = 0;
    await service.request({ op: "shutdown", deviceId: "android:Pixel" }, actor);

    expect(listOverrideCalls).toBe(1);
  });

  it("AndroidPlatform.boot leaves the console-port adb scan unguarded when switch is off", async () => {
    const root = await fakeSdkDir();
    let guardCalls = 0;
    const android = new AndroidPlatform(
      {
        platform: "linux",
        arch: "x64",
        home: root,
        env: { ANDROID_HOME: root },
        emulatorWindow: async () => false,
      },
      async (_command, args) => {
        const cmd = args.join(" ");
        if (cmd === "-list-avds") return { stdout: "Pixel\n", stderr: "", code: 0 };
        if (cmd === "devices -l")
          return { stdout: "List of devices attached\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      () => fakeProcess(),
    );
    android.setListGuard(async (read) => {
      guardCalls++;
      return read();
    });

    await android.boot({
      id: "android:Pixel",
      platform: "android",
      name: "Pixel",
      state: "shutdown",
    });
    await android.close();

    expect(guardCalls).toBe(0);
  });
});

describe.runIf(deviceInventoryBackend() === "native")(
  "inventory native boot port scan guard",
  () => {
    it("AndroidPlatform.boot serializes its console-port adb devices scan through listGuard", async () => {
      const root = await fakeSdkDir();
      let activeAdbDevices = 0;
      let maxConcurrentAdbDevices = 0;
      let adbDevicesCalls = 0;
      const reconcileEntered = Promise.withResolvers<void>();
      const reconcileGate = Promise.withResolvers<void>();

      let tail = Promise.resolve();
      const serialGuard = async <T>(read: () => Promise<T>): Promise<T> => {
        const prev = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prev;
        try {
          return await read();
        } finally {
          release();
        }
      };

      const runAdb = async (_command: string, args: readonly string[]) => {
        const cmd = args.join(" ");
        if (cmd === "-list-avds") return { stdout: "Pixel\n", stderr: "", code: 0 };
        if (cmd === "devices -l") {
          const call = ++adbDevicesCalls;
          activeAdbDevices++;
          maxConcurrentAdbDevices = Math.max(maxConcurrentAdbDevices, activeAdbDevices);
          try {
            if (call === 2) {
              reconcileEntered.resolve();
              await reconcileGate.promise;
            }
            return { stdout: "List of devices attached\n", stderr: "", code: 0 };
          } finally {
            activeAdbDevices--;
          }
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      let reconcilePromise: Promise<void> | undefined;
      const android = new AndroidPlatform(
        {
          platform: "linux",
          arch: "x64",
          home: root,
          env: { ANDROID_HOME: root },
          async emulatorWindow() {
            // Parked after current() released listGuard, right before boot()'s console-port scan.
            reconcilePromise = serialGuard(async () => {
              await runAdb("adb", ["devices", "-l"]);
            });
            await Promise.race([
              reconcileEntered.promise,
              bootPromise.then(() => {
                throw new Error("boot exited before reconcile entered");
              }),
            ]);
            return false;
          },
        },
        runAdb,
        () => fakeProcess(),
      );
      android.setListGuard(serialGuard);

      const bootPromise = android.boot({
        id: "android:Pixel",
        platform: "android",
        name: "Pixel",
        state: "shutdown",
      });
      await reconcileEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Call 1 was current(), call 2 is the in-flight reconcile holding the guard.
      // boot()'s port scan (call 3) must wait for the guard rather than overlapping call 2.
      expect(adbDevicesCalls).toBe(2);
      expect(maxConcurrentAdbDevices).toBe(1);

      reconcileGate.resolve();
      await Promise.all([bootPromise, reconcilePromise]);
      await android.close();

      expect(adbDevicesCalls).toBe(3);
      expect(maxConcurrentAdbDevices).toBe(1);
    });
  },
);
