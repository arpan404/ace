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
  type DeviceRecord,
  type GrpcEndpoint,
  type IosBoot,
  type ListAnswer,
  type ListSource,
  type OpenAppPlan,
  type Selected,
  type Step,
  type ToolsPlan,
  envStrings,
  nativeDevices,
} from "./native-devices-addon.ts";
import { DevicePlatformBase } from "./platform-base.ts";
import { DeviceError, deviceAnswer } from "./sdk.ts";

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
      nativeDevices().devicePlatformIdentity(device.id, capture, JSON.stringify(inventory)),
    );
    return DeviceSchema.parse({ ...device, ...selected });
  }

  /** Every platform's devices, with the composition and the missing-SDK rules in Rust. */
  override async list(): Promise<Device[]> {
    const sources: ListSource[] = [];
    if (this.options.platform === "darwin") {
      sources.push(
        await this.#source("ios", async () =>
          (await this.simulators.list()).map((entry) =>
            deviceAnswer<DeviceRecord>(() =>
              nativeDevices().devicePlatformSimulatorRecord(
                JSON.stringify({
                  udid: entry.udid,
                  name: entry.name,
                  state: entry.state,
                  runtime: entry.runtime,
                  deviceTypeIdentifier: entry.deviceTypeIdentifier,
                }),
              ),
            ),
          ),
        ),
      );
    }
    sources.push(await this.#source("android", () => this.android.list()));
    const answer = deviceAnswer<ListAnswer>(() =>
      nativeDevices().devicePlatformList(JSON.stringify(sources)),
    );
    this.setMissingSDKs(
      answer.missing.map((missing) => ({
        code: missing.code as DeviceError["code"],
        message: missing.message,
        hint: missing.hint,
        platform: missing.platform as Device["platform"],
      })),
    );
    const devices = answer.devices.map((device) => DeviceSchema.parse(device));
    await this.adoptInventory(devices);
    return devices;
  }

  /** One platform's read as a source, its `sdk_missing` refusal kept rather than thrown. */
  async #source(
    platform: Device["platform"],
    read: () => Promise<DeviceRecord[]>,
  ): Promise<ListSource> {
    try {
      return { platform, devices: await read() };
    } catch (error) {
      if (error instanceof DeviceError)
        return {
          platform,
          devices: [],
          failure: { code: error.code, message: error.message, hint: error.hint },
        };
      throw error;
    }
  }

  override async boot(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform !== "ios") {
      await this.android.boot(device, authorize);
      return;
    }
    // A Simulator ace does not know must not be launched by a stale id, and the listed state,
    // not the caller's record, decides whether it needs booting.
    const listed = await this.simulators.list();
    const entry = listed.find((candidate) => `ios:${candidate.udid}` === device.id);
    if (!entry) throw new Error("Unknown available simulator");
    const plan = deviceAnswer<IosBoot>(() =>
      nativeDevices().devicePlatformIosBoot(device.id, entry.state === "Booted"),
    );
    if (plan.boot) await this.simctl(device, ["boot"], authorize, 240_000);
    const { open } = await this.xcode();
    authorize?.();
    await this.run(open, plan.show, 256 * 1024, undefined, undefined, authorize);
  }

  override async shutdown(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform !== "ios") {
      await this.android.shutdown(device, authorize);
      return;
    }
    const steps = deviceAnswer<Step[]>(() =>
      nativeDevices().devicePlatformShutdown(device.platform),
    );
    await this.#run(device, steps, authorize);
    this.appProcesses.delete(device.id);
  }

  override async install(device: Device, input: string, authorize?: () => void): Promise<void> {
    const steps = deviceAnswer<Step[]>(() =>
      nativeDevices().devicePlatformInstall(device.platform, input),
    );
    await this.#run(device, steps, authorize);
  }

  override async openApp(device: Device, input: string, authorize?: () => void): Promise<void> {
    const addon = nativeDevices();
    let plan = deviceAnswer<OpenAppPlan>(() => addon.devicePlatformOpenApp(device.platform, input));
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

  /** What a tools download fetches: the catalogue's decision, not the shell's. */
  protected override toolsPlan(): ToolsPlan {
    return deviceAnswer<ToolsPlan>(() =>
      nativeDevices().devicePlatformDownloadPlan(
        this.options.platform,
        this.options.toolsDirectory,
        this.options.node,
      ),
    );
  }

  /**
   * How to encode an emulator's picture on the host: a helper, a place for the shared picture
   * file, and the emulator's gRPC endpoint (one ace booted). The running directory and the
   * discovery parse are the platform's; files are read in order and reading stops at the first
   * one that names this emulator, so a FIFO or an unreadable sibling is never opened.
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
    let entries;
    try {
      entries = await readdir(running, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      let text: string;
      try {
        text = await readFile(join(running, entry.name), "utf8");
      } catch {
        // A file that vanished or cannot be read names no endpoint; the next one still can.
        continue;
      }
      const match = deviceAnswer<{ matched: boolean; grpc: GrpcEndpoint | null }>(() =>
        addon.devicePlatformEmulatorGrpcFile(serial, entry.name, text),
      );
      if (!match.matched) continue;
      return match.grpc ? { grpc: match.grpc, encoder, directory } : undefined;
    }
    return undefined;
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
