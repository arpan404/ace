import { isAbsolute } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { findAndroidTools } from "./android-tools.ts";
import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
import type { DeviceFailure } from "@ace/protocol/devices";
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { catalogWord } from "./catalog.ts";
import { type RefusalWord, answered, nativeDevices, Refused } from "./native-devices-addon.ts";

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
/** The addon's refusal as today's `DeviceError`, so `instanceof` and its code both hold. */
export function deviceRefusal(word: RefusalWord): DeviceError {
  return new DeviceError(word.code as DeviceErrorCode, word.message, word.hint);
}
/** Runs one addon export, raising its refusal as the `DeviceError` it names. */
export function deviceAnswer<T>(invoke: () => string): T {
  try {
    return answered<T>(invoke);
  } catch (error) {
    if (error instanceof Refused) throw deviceRefusal(error.refusal);
    throw error;
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
  if (devicePlatformBackend() === "native")
    return deviceAnswer<{ adb: string; emulator?: string | undefined }>(() =>
      nativeDevices().devicePlatformResolveAndroidSdk(
        adb,
        emulator,
        options.platform,
        options.arch,
      ),
    );
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
  if (devicePlatformBackend() === "native")
    return deviceRefusal(
      deviceAnswer<RefusalWord>(() => nativeDevices().devicePlatformIosNeedsMac()),
    );
  const word = catalogWord("iosNeedsMac");
  return new DeviceError(word.code, word.message, word.hint);
}
/** Said once in the device list on Linux arm64, where Google publishes no Android Emulator. */
export function armEmulatorNote(): DeviceError {
  if (devicePlatformBackend() === "native")
    return deviceRefusal(
      deviceAnswer<RefusalWord>(() => nativeDevices().devicePlatformArmEmulatorNote()),
    );
  const word = catalogWord("armEmulatorNote");
  return new DeviceError(word.code, word.message, word.hint);
}
export async function resolveXcode(options: SDKOptions): Promise<{ xcrun: string; open: string }> {
  if (devicePlatformBackend() === "native") return resolveXcodeNatively(options);
  if (options.platform === "win32") throw iosNeedsMac();
  if (options.platform !== "darwin") {
    const word = catalogWord("iosNeedsMacOs");
    throw new DeviceError(word.code, word.message, word.hint);
  }
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

/**
 * `resolveXcode` with `ace-devices` deciding the refusals. The executables and the selection
 * probe stay here, in today's order: the host refusal first, then the tools, then the probe.
 */
async function resolveXcodeNatively(options: SDKOptions): Promise<{ xcrun: string; open: string }> {
  const addon = nativeDevices();
  const host = deviceAnswer<RefusalWord | null>(() =>
    addon.devicePlatformXcodeHostRefusal(options.platform),
  );
  if (host) throw deviceRefusal(host);
  const [select, xcrun, open] = await Promise.all(
    ["xcode-select", "xcrun", "open"].map((name) => findExecutable(name, options.env)),
  );
  if (!select || !xcrun || !open)
    throw deviceRefusal(deviceAnswer<RefusalWord>(() => addon.devicePlatformXcodeToolsRefusal()));
  let output;
  try {
    output = await (options.probe ?? probeOutput)(select, ["-p"], {
      env: options.env,
      maxBytes: 4096,
    });
  } catch {
    // The probe could not run at all: today's own refusal, distinct from a failing selection.
    throw deviceRefusal(deviceAnswer<RefusalWord>(() => addon.devicePlatformXcodeProbeFailure()));
  }
  const refused = deviceAnswer<RefusalWord | null>(() =>
    addon.devicePlatformXcodeSelection(output.code, output.stdout),
  );
  if (refused) throw deviceRefusal(refused);
  return { xcrun, open };
}
