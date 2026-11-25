// SPDX-License-Identifier: Apache-2.0

/**
 * The devices addon (D3.1): loading it, and the one shape every export answers. It imports
 * nothing from the package, so both the platform shell and the SDK helpers can reach it without
 * a cycle: a caller turns a refusal into the `DeviceError` it names.
 */
import { fileURLToPath } from "node:url";

/** One SDK command the addon decided: `simctl` through `xcrun`, or the device's adb. */
export interface Step {
  kind: "simctl" | "adb";
  args: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** `openApp`'s answer: the launch steps, or the lookup whose output decides them. */
export interface OpenAppPlan {
  steps: Step[];
  resolve?: Step;
}

/** What the listed Simulator turns the device into. */
export interface Selected {
  name: string;
  state: "booted";
  runtime: string;
}

export interface SimulatorEntry {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export interface DiscoveryFile {
  name: string;
  text: string;
}

/** An emulator's gRPC endpoint, when it serves one ace may use. */
export interface GrpcEndpoint {
  port: number;
  token: string;
}

/** A refusal as the addon writes it: today's `DeviceError`, field for field. */
export interface RefusalWord {
  code: string;
  message: string;
  hint: string;
}

/** One SDK root ace may read: what its `platform-tools` and `emulator` folders hold. */
export interface FoundTools {
  adb?: string | undefined;
  emulator?: string | undefined;
}

/** The Android tools ace runs, by absolute path. */
export interface AndroidTools {
  adb?: string | undefined;
  emulator?: string | undefined;
}

interface Answer<T> {
  ok: boolean;
  value?: T;
  error?: RefusalWord;
}

/** The addon's exports, as `ace-daemon-node/src/devices` declares them. */
interface DevicesAddon {
  devicePlatformIdentity(id: string, capture: boolean, inventory: SimulatorEntry[]): string;
  devicePlatformInstall(platform: string, path: string): string;
  devicePlatformOpenApp(platform: string, app: string, resolved?: string): string;
  devicePlatformOpenUrl(platform: string, url: string): string;
  devicePlatformConfigure(platform: string, settings: string, physical: boolean): string;
  devicePlatformLaunchPid(stdout: string): string | null;
  devicePlatformConsolePort(serial: string): number | null;
  devicePlatformRunningDirectory(
    platform: string,
    home: string,
    env: Record<string, string>,
  ): string | null;
  devicePlatformEmulatorGrpc(serial: string, files: DiscoveryFile[]): string;
  devicePlatformXcodeHostRefusal(platform: string): string;
  devicePlatformXcodeToolsRefusal(): string;
  devicePlatformXcodeSelection(code: number | null, stdout: string): string;
  devicePlatformIosNeedsMac(): string;
  devicePlatformArmEmulatorNote(): string;
  devicePlatformAndroidSdkRoots(
    platform: string,
    home: string | undefined,
    env: Record<string, string>,
  ): string[];
  devicePlatformChooseAndroidTools(found: FoundTools[], pathAdb?: string): string;
  devicePlatformResolveAndroidSdk(
    adb: string | undefined,
    emulator: string | undefined,
    platform: string,
    arch?: string,
  ): string;
  devicePlatformXcodeHostRefusal(platform: string): string;
  devicePlatformXcodeToolsRefusal(): string;
  devicePlatformXcodeSelection(code: number | null, stdout: string): string;
  devicePlatformIosNeedsMac(): string;
  devicePlatformArmEmulatorNote(): string;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_DEVICE_PLATFORM_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_DEVICE_PLATFORM_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: DevicesAddon | undefined;

/** The devices addon, failing rather than falling back when the switch is on. */
export function nativeDevices(): DevicesAddon {
  if (loaded) return loaded;
  const path = addonPath();
  const module = { exports: {} as Record<string, unknown> };
  try {
    process.dlopen(module, path);
  } catch (error) {
    throw new Error(
      `ACE_DEVICE_PLATFORM=native needs the devices addon at ${path}; build it with cargo build --release -p ace-daemon-node in native/daemon`,
      { cause: error },
    );
  }
  // Trusted: the addon this tree built, exporting what `ace-daemon-node/src/devices` declares.
  loaded = module.exports as unknown as DevicesAddon;
  return loaded;
}

/** One export's answer: its value, or the refusal the caller raises as a `DeviceError`. */
export function answered<T>(invoke: () => string): T {
  const answer = JSON.parse(invoke()) as Answer<T>;
  if (!answer.ok || answer.error) throw new Refused(answer.error);
  return answer.value as T;
}

/** A refusal the addon answered outside an envelope; a caller re-raises it as `DeviceError`. */
export class Refused extends Error {
  readonly refusal: RefusalWord;
  constructor(refusal: RefusalWord | undefined) {
    super(refusal?.message ?? "The device platform refused without a message");
    this.name = "Refused";
    this.refusal = refusal ?? {
      code: "command_failed",
      message: "The device platform refused without a message",
      hint: "Restart ace.",
    };
  }
}

/** The environment as the addon takes it: only the variables this process set. */
export function envStrings(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) strings[key] = value;
  return strings;
}
