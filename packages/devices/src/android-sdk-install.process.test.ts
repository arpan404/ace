import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // No SDK for either platform: the inventory fails, and still says where iOS work goes.
    await expect(platform.list()).rejects.toThrow("platform-tools were not found");
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

/*
 * A copy of node.exe named adb.exe, turned into a fake by a preloaded script: `adb devices -l`
 * reports one emulator and one USB phone. Node rejects adb's `-s <serial>` probes as unknown
 * options, so those fail the way an unreachable device's do and the devices keep their transport
 * names.
 */
const fakeAdb = String.raw`
const { basename } = require("node:path");
if (basename(process.execPath).toLowerCase() === "adb.exe" && basename(process.argv[1] ?? "") === "devices") {
  process.stdout.write([
    "List of devices attached",
    "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
    "R5CT1234567            device usb:1-1 product:panther model:Pixel_7 device:panther transport_id:2",
    "",
  ].join("\r\n"));
  process.exit(0);
}
`;

it.runIf(windows)(
  "on Windows, an emulator and a USB phone that adb.exe reports appear in the device list",
  async () => {
    const local = await folder();
    const tools = join(local, "Android", "Sdk", "platform-tools");
    await mkdir(tools, { recursive: true });
    await copyFile(process.execPath, join(tools, "adb.exe"));
    const preload = join(local, "fake-adb.cjs");
    await writeFile(preload, fakeAdb);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      LOCALAPPDATA: local,
      ANDROID_HOME: undefined,
      ANDROID_SDK_ROOT: undefined,
      // NODE_OPTIONS reads backslashes inside quotes as escapes; forward slashes keep the path.
      NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
    };
    const platform = new DevicePlatform({ platform: "win32", home: local, env });
    const devices = await platform.list();
    expect(devices).toContainEqual(
      expect.objectContaining({
        platform: "android",
        state: "booted",
        serial: "emulator-5554",
      }),
    );
    expect(devices).toContainEqual(
      expect.objectContaining({
        platform: "android",
        name: "Pixel 7",
        state: "booted",
        serial: "R5CT1234567",
      }),
    );
  },
);

// The x64 runner image ships an Android SDK (ANDROID_HOME); the ARM64 image doesn't.
it.runIf(windows && Boolean(process.env.ANDROID_HOME))(
  "on Windows, a real Android SDK's adb.exe is found under ANDROID_HOME and lists devices",
  async ({ skip }) => {
    const sdk = process.env.ANDROID_HOME;
    if (!sdk) return skip("No Android SDK on this runner");
    const home = await folder();
    const tools = await findAndroidTools({ env: { ...process.env }, home });
    expect(tools.adb).toBe(join(sdk, "platform-tools", "adb.exe"));
    const platform = new DevicePlatform({ platform: "win32", home, env: { ...process.env } });
    const devices = await platform.list();
    expect(devices.every((device) => device.platform === "android")).toBe(true);
    expect(platform.diagnostics().filter((issue) => issue.platform === "android")).toEqual([]);
  },
);
