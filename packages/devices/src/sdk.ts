import { join, isAbsolute } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
import type { DeviceFailure } from "@ace/protocol/devices";
import { androidSdkRoots } from "./sdk-roots.ts";

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
export async function resolveAndroidSDK(
  options: SDKOptions,
): Promise<{ adb: string; emulator: string }> {
  for (const root of androidSdkRoots(options.env, options.home)) {
    const [adb, emulator] = await Promise.all([
      findExecutable(join(root, "platform-tools/adb"), options.env),
      findExecutable(join(root, "emulator/emulator"), options.env),
    ]);
    if (adb && emulator) return { adb, emulator };
  }
  // Google's SDK repository has the emulator and platform-tools for x86-64 Linux only, so
  // there is nothing to install here.
  if (options.platform === "linux" && options.arch === "arm64")
    throw new DeviceError(
      "sdk_missing",
      "Android emulators aren't available on Linux arm64",
      "Google publishes the Android Emulator and Platform Tools for x86-64 Linux only; use Android devices from a Mac or an x86-64 Linux machine.",
    );
  throw new DeviceError(
    "sdk_missing",
    "Android SDK platform-tools and emulator were not found",
    "Install Android Studio's Platform Tools and Android Emulator, then set ANDROID_HOME to the SDK directory.",
  );
}
export async function resolveXcode(options: SDKOptions): Promise<{ xcrun: string; open: string }> {
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
