import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnSupervised } from "@ace/provider-kit/process";
import { DevicePlatform, type Device } from "./index.ts";

const pixel: Device = {
  id: "android:Pixel_API_35",
  platform: "android",
  name: "Pixel_API_35",
  state: "shutdown",
};

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });

/**
 * An SDK whose emulator stays running until stopped, and an adb that reports it booted once
 * started. Returns the arguments each emulator ace started was given.
 */
async function bootEmulator(options: {
  platform: string;
  emulatorWindow?: () => boolean | Promise<boolean>;
}) {
  const home = await mkdtemp(join(tmpdir(), "ace-emulator-window-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sdk = join(home, "Library/Android/sdk");
  await mkdir(join(sdk, "platform-tools"), { recursive: true });
  await mkdir(join(sdk, "emulator"), { recursive: true });
  await nodeBinary(join(sdk, "platform-tools"), "adb", "");
  await nodeBinary(join(sdk, "emulator"), "emulator", "process.stdin.resume();");
  const started: string[][] = [];
  const platform = new DevicePlatform({
    platform: options.platform,
    home,
    env: { PATH: "/usr/bin:/bin" },
    ...(options.emulatorWindow ? { emulatorWindow: options.emulatorWindow } : {}),
    spawn: (spawn) => {
      if (spawn.name === "device-emulator") started.push([...(spawn.args ?? [])]);
      return spawnSupervised(spawn);
    },
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return ok("Pixel_API_35");
      if (args[0] === "devices")
        return ok(
          started.length === 0
            ? "List of devices attached\n"
            : "List of devices attached\nemulator-5554 device product:sdk model:pixel",
        );
      if (args.includes("ro.boot.qemu.avd_name") || args.includes("avd"))
        return ok("Pixel_API_35\n");
      // The console can't stop the fake emulator; ace stops its process instead.
      if (args.includes("kill")) return { stdout: "", stderr: "", code: 1 };
      return ok();
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => platform.close());
  await platform.boot(pixel);
  return started;
}

it("ace boots an emulator without its window unless the person asked to see it", async () => {
  for (const emulatorWindow of [undefined, () => false]) {
    const started = await bootEmulator({
      platform: "linux",
      ...(emulatorWindow ? { emulatorWindow } : {}),
    });
    expect(started).toEqual([
      ["-avd", "Pixel_API_35", "-port", "5554", "-no-window", "-no-boot-anim"],
    ]);
  }
});

it("a headless emulator on macOS renders with the host GPU and streams its screen to the host", async () => {
  const started = await bootEmulator({ platform: "darwin" });
  expect(started).toEqual([
    [
      "-avd",
      "Pixel_API_35",
      "-port",
      "5554",
      "-grpc",
      "8554",
      "-grpc-use-token",
      "-no-window",
      "-no-boot-anim",
      "-gpu",
      "host",
    ],
  ]);
});

it("with Show emulator window on, the emulator boots with its window", async () => {
  const started = await bootEmulator({ platform: "darwin", emulatorWindow: async () => true });
  expect(started).toEqual([
    ["-avd", "Pixel_API_35", "-port", "5554", "-grpc", "8554", "-grpc-use-token"],
  ]);
});

it("an unreadable window setting boots the emulator without its window", async () => {
  const started = await bootEmulator({
    platform: "linux",
    emulatorWindow: async () => {
      throw new Error("settings closed");
    },
  });
  expect(started).toEqual([
    ["-avd", "Pixel_API_35", "-port", "5554", "-no-window", "-no-boot-anim"],
  ]);
});
