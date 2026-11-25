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
/** The catalog's refusal `key`, as today's `DeviceError`: the one place the TypeScript reads a word. */
export function catalogRefusal(key: string): DeviceError {
  const word = catalogWord(key);
  return new DeviceError(word.code, word.message, word.hint);
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
  const key =
    options.platform === "linux"
      ? options.arch === "arm64"
        ? "adbMissingArm"
        : "adbMissingLinux"
      : "sdkMissing";
  const word = catalogWord(key);
  throw new DeviceError(word.code, word.message, word.hint);
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
/** The injected scheduler in `probeOutput`'s order, when the native platform gave one. */
function probeSchedule(
  options: SDKOptions,
): ((run: () => void, ms: number) => () => void) | undefined {
  if (devicePlatformBackend() !== "native") return undefined;
  const after = options.after;
  return after ? (run, ms) => after(ms, run) : undefined;
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
  if (!select || !xcrun || !open) {
    const word = catalogWord("xcodeMissing");
    throw new DeviceError(word.code, word.message, word.hint);
  }
  let output;
  try {
    const schedule = probeSchedule(options);
    output = await (options.probe ?? probeOutput)(select, ["-p"], {
      env: options.env,
      maxBytes: 4096,
      ...(schedule ? { schedule } : {}),
    });
  } catch {
    const word = catalogWord("xcodeUnavailable");
    throw new DeviceError(word.code, word.message, word.hint);
  }
  if (
    output.code !== 0 ||
    !z.string().max(4096).refine(isAbsolute).safeParse(output.stdout).success ||
    output.stdout.endsWith("CommandLineTools")
  ) {
    const word = catalogWord("xcodeNotFull");
    throw new DeviceError(word.code, word.message, word.hint);
  }
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
    const schedule = probeSchedule(options);
    output = await (options.probe ?? probeOutput)(select, ["-p"], {
      env: options.env,
      maxBytes: 4096,
      ...(schedule ? { schedule } : {}),
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
