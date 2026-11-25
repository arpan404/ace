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
import {
  AppDevice as DeviceSchema,
  type AppDevice as Device,
  DeviceSettings as Settings,
  type DeviceSettings,
} from "@ace/protocol/devices";
import type { EmulatorGrpc } from "./emulator-discovery.ts";
import {
  type DiscoveryFile,
  type GrpcEndpoint,
  type OpenAppPlan,
  type Selected,
  type Step,
  envStrings,
  nativeDevices,
} from "./native-devices-addon.ts";
import { DevicePlatformBase } from "./platform-base.ts";
import { deviceAnswer } from "./sdk.ts";

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
    const selected = deviceAnswer<Selected>(() =>
      nativeDevices().devicePlatformIdentity(device.id, capture, inventory),
    );
    return DeviceSchema.parse({ ...device, ...selected });
  }

  override async install(device: Device, input: string, authorize?: () => void): Promise<void> {
    const steps = deviceAnswer<Step[]>(() =>
      nativeDevices().devicePlatformInstall(device.platform, input),
    );
    await this.#run(device, steps, authorize);
  }

  override async openApp(device: Device, input: string, authorize?: () => void): Promise<void> {
    const addon = nativeDevices();
    let plan = deviceAnswer<OpenAppPlan>(() =>
      addon.devicePlatformOpenApp(device.platform, input),
    );
    if (plan.resolve) {
      // Today's resolve-activity lookup runs without the guard (it changes nothing) and the
      // launch that follows re-checks the caller's lifetime.
      const resolved = await this.#run(device, [plan.resolve]);
      plan = deviceAnswer<OpenAppPlan>(() =>
        addon.devicePlatformOpenApp(device.platform, input, resolved),
      );
    }
    const stdout = await this.#run(device, plan.steps, authorize);
    if (device.platform === "ios") {
      const pid = addon.devicePlatformLaunchPid(stdout);
      if (pid) this.appProcesses.set(device.id, pid);
    }
  }

  override async openUrl(device: Device, input: string, authorize?: () => void): Promise<void> {
    const steps = deviceAnswer<Step[]>(() =>
      nativeDevices().devicePlatformOpenUrl(device.platform, input),
    );
    await this.#run(device, steps, authorize);
  }

  override async configure(
    device: Device,
    input: DeviceSettings,
    authorize?: () => void,
  ): Promise<void> {
    const settings = Settings.parse(input);
    const steps = deviceAnswer<Step[]>(() =>
      nativeDevices().devicePlatformConfigure(
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
    const addon = nativeDevices();
    if (!addon.devicePlatformConsolePort(serial)) return undefined;
    const running = addon.devicePlatformRunningDirectory(
      this.options.platform,
      this.options.home,
      envStrings(this.options.env),
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
    const { grpc } = deviceAnswer<{ grpc: GrpcEndpoint | null }>(() =>
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
