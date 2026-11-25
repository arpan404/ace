// SPDX-License-Identifier: Apache-2.0

/**
 * The native device platform (D3.1): the methods `ace-devices` decides, inside today's
 * `DevicePlatform`. Each override asks the addon for the exact SDK command (or the refusal)
 * and still runs it through the inherited platform, so the supervisor, the concurrency limit,
 * the abort signal, the lease guard and the command journal stay where they were. Methods this
 * item has not reached are inherited unchanged: the platform grows method by method.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppDevice as DeviceSchema,
  type AppDevice as Device,
  DeviceSettings as Settings,
  type DeviceSettings,
} from "@ace/protocol/devices";
import type { EmulatorGrpc } from "./emulator-discovery.ts";
import { DevicePlatformBase } from "./platform-base.ts";
import { DeviceError, type DeviceErrorCode } from "./sdk.ts";

/** One SDK command the addon decided: `simctl` through `xcrun`, or the device's adb. */
interface Step {
  kind: "simctl" | "adb";
  args: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** `openApp`'s answer: the launch steps, or the lookup whose output decides them. */
interface OpenAppPlan {
  steps: Step[];
  resolve?: Step;
}

/** What the listed Simulator turns the device into. */
interface Selected {
  name: string;
  state: "booted";
  runtime: string;
}

interface SimulatorEntry {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

interface DiscoveryFile {
  name: string;
  text: string;
}

interface Answer<T> {
  ok: boolean;
  value?: T;
  error?: { code: DeviceErrorCode; message: string; hint: string };
}

/** The addon's exports, as `ace-daemon-node/src/devices/platform.rs` declares them. */
interface DevicePlatformAddon {
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

let loaded: DevicePlatformAddon | undefined;

/** The device platform's addon, failing rather than falling back when the switch is on. */
function nativePlatform(): DevicePlatformAddon {
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
  loaded = module.exports as unknown as DevicePlatformAddon;
  return loaded;
}

/** Runs one addon call: its value, or the `DeviceError` its refusal names. */
function call<T>(invoke: () => string): T {
  const answer = JSON.parse(invoke()) as Answer<T>;
  if (!answer.ok || answer.error) {
    const error = answer.error ?? {
      code: "command_failed" as const,
      message: "The device platform answered without a value",
      hint: "Restart ace.",
    };
    throw new DeviceError(error.code, error.message, error.hint);
  }
  return answer.value as T;
}

export class NativeDevicePlatform extends DevicePlatformBase {
  override async simulatorDevice(input: Device): Promise<Device> {
    return this.#selected(input, false);
  }

  override async simulatorCaptureDevice(input: Device): Promise<Device> {
    return this.#selected(input, true);
  }

  async #selected(device: Device, capture: boolean): Promise<Device> {
    const inventory = (await this.simulators.list()).map((entry) => ({
      udid: entry.udid,
      name: entry.name,
      state: entry.state,
      runtime: entry.runtime,
    }));
    const selected = call<Selected>(() =>
      nativePlatform().devicePlatformIdentity(device.id, capture, inventory),
    );
    return DeviceSchema.parse({ ...device, ...selected });
  }

  override async install(device: Device, input: string, authorize?: () => void): Promise<void> {
    const steps = call<Step[]>(() =>
      nativePlatform().devicePlatformInstall(device.platform, input),
    );
    await this.#run(device, steps, authorize);
  }

  override async openApp(device: Device, input: string, authorize?: () => void): Promise<void> {
    const addon = nativePlatform();
    let plan = call<OpenAppPlan>(() => addon.devicePlatformOpenApp(device.platform, input));
    if (plan.resolve) {
      // Today's resolve-activity lookup runs without the guard (it changes nothing) and the
      // launch that follows re-checks the caller's lifetime.
      const resolved = await this.#run(device, [plan.resolve]);
      plan = call<OpenAppPlan>(() => addon.devicePlatformOpenApp(device.platform, input, resolved));
    }
    const stdout = await this.#run(device, plan.steps, authorize);
    if (device.platform === "ios") {
      const pid = addon.devicePlatformLaunchPid(stdout);
      if (pid) this.appProcesses.set(device.id, pid);
    }
  }

  override async openUrl(device: Device, input: string, authorize?: () => void): Promise<void> {
    const steps = call<Step[]>(() =>
      nativePlatform().devicePlatformOpenUrl(device.platform, input),
    );
    await this.#run(device, steps, authorize);
  }

  override async configure(
    device: Device,
    input: DeviceSettings,
    authorize?: () => void,
  ): Promise<void> {
    const settings = Settings.parse(input);
    const steps = call<Step[]>(() =>
      nativePlatform().devicePlatformConfigure(
        device.platform,
        JSON.stringify(settings),
        this.android.physical(device.id),
      ),
    );
    await this.#run(device, steps, authorize);
  }

  /**
   * How to encode an emulator's picture on the host: a helper, a place for the shared picture
   * file, and the emulator's gRPC endpoint (one ace booted). The running directory and the
   * discovery parse are the platform's; the files are read here.
   */
  override async hostEncoding(
    serial: string,
  ): Promise<{ grpc: EmulatorGrpc; encoder: string; directory: string } | undefined> {
    const { frameEncoder: encoder, toolsDirectory: directory } = this.options;
    if (this.options.platform !== "darwin" || !encoder || !directory) return undefined;
    const addon = nativePlatform();
    if (!addon.devicePlatformConsolePort(serial)) return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env))
      if (value !== undefined) env[key] = value;
    const running = addon.devicePlatformRunningDirectory(
      this.options.platform,
      this.options.home,
      env,
    );
    if (!running) return undefined;
    let names: string[];
    try {
      names = await readdir(running);
    } catch {
      return undefined;
    }
    const files: DiscoveryFile[] = [];
    for (const name of names) {
      try {
        files.push({ name, text: await readFile(join(running, name), "utf8") });
      } catch {
        // A file that vanished or cannot be read names no endpoint; the next one still can.
      }
    }
    const { grpc } = call<{ grpc: EmulatorGrpc | null }>(() =>
      addon.devicePlatformEmulatorGrpc(serial, files),
    );
    return grpc ? { grpc, encoder, directory } : undefined;
  }

  /** Runs the decided steps in order, returning the last one's stdout. */
  async #run(device: Device, steps: readonly Step[], authorize?: () => void): Promise<string> {
    let stdout = "";
    for (const step of steps) {
      if (step.kind === "simctl")
        stdout = (await this.simctl(device, step.args, authorize, step.timeoutMs)).stdout;
      else
        stdout = (
          await this.android.adb(device, step.args, step.maxBytes, authorize, step.timeoutMs)
        ).stdout;
    }
    return stdout;
  }
}
