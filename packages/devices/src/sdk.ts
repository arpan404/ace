import { isAbsolute } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { findAndroidTools } from "./android-tools.ts";
import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
import type { DeviceFailure } from "@ace/protocol/devices";

export type DeviceErrorCode = DeviceFailure["code"];
export class DeviceError extends Error {
  readonly code: DeviceErrorCode;
  readonly hint: string;
  /** The macOS permission the screen helper lacks, when that is why this failed. */
  readonly permission: DeviceFailure["permission"];
  constructor(
    code: DeviceErrorCode,
    message: string,
    hint: string,
    permission?: DeviceFailure["permission"],
  ) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.hint = hint;
    this.permission = permission;
  }
}
export type SDKOptions = {
  platform: string;
  /** The CPU architecture, as `process.arch` names it. */
  arch?: string;
  home: string;
  env: NodeJS.ProcessEnv;
  probe?: typeof probeOutput;
  after?: (ms: number, run: () => void) => () => void;
};
/** The adb ace drives Android devices with, and the emulator when one is installed. */
export async function resolveAndroidSDK(
  options: SDKOptions,
): Promise<{ adb: string; emulator?: string | undefined }> {
  const { adb, emulator } = await findAndroidTools({ env: options.env, home: options.home });
  if (adb) return { adb, emulator };
  // Google's SDK repository has the emulator and platform-tools for x86-64 Linux only; on arm64
  // a distribution's adb still reaches phones and network devices.
  if (options.platform === "linux" && options.arch === "arm64")
    throw new DeviceError(
      "sdk_missing",
      "adb was not found",
      "Install your distribution's adb (Debian/Ubuntu: sudo apt install adb) to use Android phones and network devices. Android emulators aren't available on Linux arm64.",
    );
  if (options.platform === "linux")
    throw new DeviceError(
      "sdk_missing",
      "adb was not found",
      "Install your distribution's adb (Debian/Ubuntu: sudo apt install adb) for Android phones, or Android Studio's Platform Tools and Android Emulator with ANDROID_HOME set to the SDK directory for emulators too.",
    );
  throw new DeviceError(
    "sdk_missing",
    "Android SDK platform-tools were not found",
    "Install Android Studio's Platform Tools and Android Emulator, then set ANDROID_HOME to the SDK directory.",
  );
}

/**
 * Windows can't run the iOS Simulator (it needs Xcode). Said in the device list, and as the
 * refusal of every Simulator action, so people and agents know where that work goes instead.
 */
export function iosNeedsMac(): DeviceError {
  return new DeviceError(
    "not_supported",
    "iOS Simulators need a paired Mac",
    "Pair a Mac running ace in Settings › Fleet and use its Simulators there; agents can delegate that work to the Mac. Android emulators and phones work on this Windows machine.",
  );
}
/** Said once in the device list on Linux arm64, where Google publishes no Android Emulator. */
export function armEmulatorNote(): DeviceError {
  return new DeviceError(
    "not_supported",
    "Android emulators aren't available on Linux arm64",
    "Google publishes the Android Emulator for x86-64 Linux only. Android phones on USB and devices on the network work here through adb.",
  );
}
export async function resolveXcode(options: SDKOptions): Promise<{ xcrun: string; open: string }> {
  if (options.platform === "win32") throw iosNeedsMac();
  if (options.platform !== "darwin")
    throw new DeviceError(
      "not_supported",
      "iOS Simulator requires macOS",
      "Use a macOS daemon with Xcode installed.",
    );
  const [select, xcrun, open] = await Promise.all(
    ["xcode-select", "xcrun", "open"].map((name) => findExecutable(name, options.env)),
  );
  if (!select || !xcrun || !open)
    throw new DeviceError(
      "sdk_missing",
      "Xcode tools were not found",
      "Install Xcode and select it with xcode-select -s /Applications/Xcode.app/Contents/Developer.",
    );
  let output;
  try {
    output = await (options.probe ?? probeOutput)(select, ["-p"], {
      env: options.env,
      maxBytes: 4096,
    });
  } catch {
    throw new DeviceError(
      "sdk_missing",
      "Xcode developer directory is unavailable",
      "Run xcode-select -s /Applications/Xcode.app/Contents/Developer.",
    );
  }
  if (
    output.code !== 0 ||
    !z.string().max(4096).refine(isAbsolute).safeParse(output.stdout).success ||
    output.stdout.endsWith("CommandLineTools")
  )
    throw new DeviceError(
      "sdk_missing",
      "A full Xcode installation is required",
      "Run xcode-select -s /Applications/Xcode.app/Contents/Developer, then accept the Xcode license.",
    );
  return { xcrun, open };
}
