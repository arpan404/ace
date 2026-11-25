// SPDX-License-Identifier: Apache-2.0

/**
 * The switch-off Android platform keeps today's behaviour exactly: the SDK refusal comes before
 * any probe, so a failing window or `adb devices` lookup can never replace it.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSupervised } from "@ace/provider-kit/process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AndroidPlatform } from "./android-platform.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-android-platform-"));
  await mkdir(join(root, "platform-tools"), { recursive: true });
  await writeFile(join(root, "platform-tools", "adb"), "#!/bin/sh\nexit 1\n");
  await chmod(join(root, "platform-tools", "adb"), 0o700);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a host without an emulator refuses before the window and devices probes", async () => {
  const ran: string[] = [];
  let windowed = 0;
  const answer = async (command: string, args: readonly string[]) => {
    ran.push([command, ...args].join(" "));
    return { stdout: "", stderr: "", code: 0 };
  };
  const android = new AndroidPlatform(
    {
      platform: "darwin",
      home: root,
      env: { ANDROID_HOME: root },
      emulatorWindow: () => {
        windowed++;
        return false;
      },
    },
    answer,
    spawnSupervised,
  );
  android.current = async (device) => device;
  await expect(
    android.boot({
      id: "android:Pixel_API_35",
      platform: "android",
      name: "Pixel_API_35",
      state: "shutdown",
    }),
  ).rejects.toThrow("The Android Emulator was not found");
  expect(windowed).toBe(0);
  expect(ran).toEqual([]);
});
