import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { findAndroidTools } from "./android-tools.ts";
import { DevicePlatform } from "./platform.ts";
import { resolveXcode } from "./sdk.ts";

const windows = process.platform === "win32";

async function folder() {
  const directory = await mkdtemp(join(tmpdir(), "ace-android-sdk-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

it.runIf(windows)(
  "on Windows, Android Studio's default SDK under LOCALAPPDATA supplies adb.exe and emulator.exe",
  async () => {
    const local = await folder();
    const sdk = join(local, "Android", "Sdk");
    await mkdir(join(sdk, "platform-tools"), { recursive: true });
    await mkdir(join(sdk, "emulator"), { recursive: true });
    await writeFile(join(sdk, "platform-tools", "adb.exe"), "");
    await writeFile(join(sdk, "emulator", "emulator.exe"), "");
    expect(
      await findAndroidTools({
        env: { LOCALAPPDATA: local, PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        home: local,
      }),
    ).toEqual({
      adb: join(sdk, "platform-tools", "adb.exe"),
      emulator: join(sdk, "emulator", "emulator.exe"),
    });
  },
);

it.runIf(windows)(
  "on Windows, the device list says iOS Simulators need a paired Mac, and Simulator actions refuse the same way",
  async () => {
    const home = await folder();
    const platform = new DevicePlatform({ platform: "win32", home, env: { PATH: "" } });
    expect(await platform.list()).toEqual([]);
    expect(platform.diagnostics()).toContainEqual(
      expect.objectContaining({
        platform: "ios",
        code: "not_supported",
        message: "iOS Simulators need a paired Mac",
      }),
    );
    await expect(resolveXcode({ platform: "win32", home, env: {} })).rejects.toMatchObject({
      code: "not_supported",
      message: "iOS Simulators need a paired Mac",
    });
  },
);

// The x64 runner image ships an Android SDK (ANDROID_HOME); the ARM64 image doesn't.
it.runIf(windows && Boolean(process.env.ANDROID_HOME))(
  "on Windows, a real Android SDK's adb.exe lists devices",
  async () => {
    const home = await folder();
    const platform = new DevicePlatform({ platform: "win32", home, env: { ...process.env } });
    const devices = await platform.list();
    expect(devices.every((device) => device.platform === "android")).toBe(true);
    expect(platform.diagnostics().filter((issue) => issue.platform === "android")).toEqual([]);
  },
);
