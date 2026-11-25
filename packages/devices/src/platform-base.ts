import { deviceInputTimeout } from "./input-budget.ts";
import { deviceInstallTimeoutMs } from "./action-budget.ts";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { Simulators, type ScreenManager, type Simulator } from "@ace/screen";
import { probeOutput, spawnRawSupervised, spawnSupervised } from "@ace/provider-kit/process";
import { findExecutable } from "@ace/provider-kit/discovery";
import { deviceInventoryBackend, devicePlatformBackend } from "@ace/provider-kit/native-switches";
import {
  AppDevice as DeviceSchema,
  DeviceInput as InputSchema,
  type AppDevice as Device,
  type DeviceInput,
  DeviceSettings as Settings,
  type DeviceSettings,
  type DeviceFailure,
  type DeviceChrome,
  type DevicePosture,
} from "@ace/protocol/devices";
import { DeviceChromeReader } from "./device-chrome-reader.ts";
import { SimulatorPostures } from "./simulator-posture.ts";
import { EmulatorPostures, type EmulatorConsole } from "./android-posture.ts";
import { deviceChromeSources } from "./device-chrome-sources.ts";
import { unavailableImages, type ImageWork } from "@ace/media/images";
import { modelImageRuntime, type ModelImageRuntime } from "@ace/mcp-server";
import { catalogRefusal, DeviceError, deviceAnswer, resolveXcode, type SDKOptions } from "./sdk.ts";
import { nativeDevices } from "./native-devices-addon.ts";
import { iosNeedsMac } from "./sdk.ts";
import {
  adbShell,
  androidInput,
  simulatorButton,
  simulatorHID,
  simulatorInput,
  simulatorIdentity,
  simulatorDevice,
  simulatorRuntime,
  nativeId,
} from "./commands.ts";
import { AndroidOperations } from "./android-operations.ts";
import { AndroidPlatform, type AndroidOptions } from "./android-platform.ts";
import { deviceScreenshot, emulatorScreenshot, type DeviceShot } from "./one-off-screenshot.ts";
import { androidClipboardUnavailable, type ClipboardRead } from "./clipboard.ts";
import { simulatorCopy, simulatorPaste } from "./simulator-clipboard.ts";
import { downloadDeviceTools, type DeviceTools } from "./device-tools.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { managedServeSim, type ServeSimCommand } from "./serve-sim-install.ts";
import { readSimulatorScreens, type SimulatorScreen } from "./simulator-screens.ts";
import {
  emulatorConsolePort,
  emulatorGrpc,
  emulatorRunningDirectory,
  type EmulatorGrpc,
} from "./emulator-discovery.ts";

export type PlatformOptions = SDKOptions & {
  spawn?: typeof spawnSupervised;
  /** Byte-exact processes, for tools whose stdout is data rather than lines (the pasteboard). */
  spawnRaw?: typeof spawnRawSupervised;
  screen?: ScreenManager;
  /** Where ace keeps downloaded device tools (serve-sim, the scrcpy server), inside ace's home. */
  toolsDirectory?: string;
  /** The daemon's Node, which runs the tools download and ace's serve-sim. */
  node?: string;
  /**
   * The screen helper, whose `--encode-frames` mode encodes an emulator's picture on the Mac's
   * hardware (macOS only; absent elsewhere, where scrcpy's video stays).
   */
  frameEncoder?: string;
  emulatorWindow?: NonNullable<AndroidOptions["emulatorWindow"]>;
  /** Reads the SDK's device art; tests point it at fixtures. */
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
  /**
   * ace-media's image work (ADR 0208): screenshots, chrome drawn as PNG, skins' alpha and
   * Simulator bodies. Absent, each of those fails or falls back as having no image decoder.
   */
  images?: ImageWork;
};
/** An inventory issue, with the platform it concerns. */
function tagged(issue: DeviceError, platform: Device["platform"]): DeviceFailure {
  return { code: issue.code, message: issue.message, hint: issue.hint, platform };
}
export type ScreenBinding = { sessionId: string; actor: "human" | "agent"; owner: string };
const Text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const AppId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.$-]+)?$/);

export class DevicePlatformBase {
  protected readonly options: PlatformOptions;
  private readonly images: ImageWork;
  private readonly probe: typeof probeOutput;
  protected readonly simulators: Simulators;
  protected readonly android: AndroidPlatform;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly controller = new AbortController();
  private readonly androidUI: AndroidOperations;
  private missingSDKs: (DeviceFailure & { platform: Device["platform"] })[] = [];
  private lastIosOutcome: PromiseSettledResult<Device[]> | undefined;
  private lastAndroidOutcome: PromiseSettledResult<Device[]> | undefined;
  private inputHint: DeviceError | undefined;
  private checkedInput = false;
  private toolsDownload: Promise<DeviceTools> | undefined;
  protected readonly appProcesses = new Map<string, string>();
  private readonly chromes: DeviceChromeReader;
  private readonly postures: SimulatorPostures | undefined;
  private readonly emulatorPostures = new EmulatorPostures();
  diagnostics(): DeviceFailure[] {
    // Each issue says which platform it concerns, so a missing Android SDK never reads as a
    // fault of a working Simulator.
    return [
      ...this.missingSDKs,
      ...this.android.diagnostics().map((issue) => tagged(issue, "android")),
      ...(this.inputHint ? [tagged(this.inputHint, "ios")] : []),
      ...(this.options.platform === "win32" ? [tagged(iosNeedsMac(), "ios")] : []),
    ].slice(0, 2);
  }
  constructor(options: PlatformOptions) {
    this.options = options;
    this.probe = options.probe ?? probeOutput;
    this.android = new AndroidPlatform(
      options,
      (command, args, maxBytes, timeoutMs, signal, authorize) =>
        this.run(command, args, maxBytes, timeoutMs, signal, authorize),
      options.spawn ?? spawnSupervised,
    );
    this.androidUI = new AndroidOperations(this.android, (device, input, authorize) =>
      this.input(device, input, undefined, authorize),
    );
    this.simulators = this.iosSimulators();
    // The screen helper folds simulators (`--sim-posture`), on a Mac that has it.
    this.postures =
      options.platform === "darwin" && options.frameEncoder
        ? new SimulatorPostures({
            helper: options.frameEncoder,
            xcrun: async () => (await this.xcode()).xcrun,
            run: async (command, args, authorize) => {
              this.controller.signal.throwIfAborted();
              authorize?.();
              const schedule = this.probeSchedule();
              const output = await this.probe(command, args, {
                env: this.options.env,
                maxBytes: 256 * 1024,
                timeoutMs: 20_000,
                signal: this.controller.signal,
                ...(schedule ? { schedule } : {}),
              });
              return { code: output.code, stdout: output.stdout };
            },
          })
        : undefined;
    this.images =
      options.images ?? unavailableImages("the device platform was given no image work");
    this.chromes = new DeviceChromeReader(
      deviceChromeSources({
        home: options.home,
        env: options.env,
        simctl: async (args) => {
          const { xcrun } = await this.xcode();
          return (await this.run(xcrun, ["simctl", ...args], 2 * 1024 * 1024)).stdout;
        },
        plutil: async (args) => (await this.run("/usr/bin/plutil", args, 256 * 1024)).stdout,
        simulatorType: async (udid) =>
          (await this.simulators.list()).find((device) => device.udid === udid)
            ?.deviceTypeIdentifier,
        ...(options.readFile ? { readFile: options.readFile } : {}),
        images: this.images,
      }),
    );
  }
  /**
   * The device's real hardware look from the SDK on this machine: Xcode's device profile and
   * chrome for a Simulator, the emulator skin for an AVD. Undefined when there is none.
   */
  async chrome(
    device: Device,
    format?: "svg" | "png",
    posture?: DevicePosture,
  ): Promise<DeviceChrome | undefined> {
    if (device.platform === "ios" && this.options.platform !== "darwin") return undefined;
    return this.chromes.chrome(device, format, posture);
  }
  /**
   * A foldable device's posture: an iPhone Duo Simulator's or a hinged Android emulator's (a
   * Pixel Fold). Undefined for a device ace can't fold.
   */
  async posture(device: Device, authorize?: () => void): Promise<DevicePosture | undefined> {
    if (device.state !== "booted") return undefined;
    if (device.platform === "android")
      return this.emulatorPostures.read(device.id, this.emulatorConsole(device), authorize);
    if (device.platform !== "ios" || !this.postures) return undefined;
    return this.postures.read(nativeId(device), authorize);
  }
  /** Folds a foldable Simulator or emulator; returns its posture afterwards. */
  async setPosture(
    device: Device,
    posture: DevicePosture,
    authorize?: () => void,
  ): Promise<DevicePosture> {
    if (device.platform === "android")
      return this.emulatorPostures.set(device.id, this.emulatorConsole(device), posture, authorize);
    if (device.platform !== "ios" || !this.postures)
      throw new DeviceError(
        "not_supported",
        "This device doesn't fold",
        "Only foldable simulators and emulators, such as the iPhone Duo, have a posture.",
      );
    return this.postures.set(nativeId(device), posture, authorize);
  }
  /** The device's emulator console through adb; a failed command answers with its exit code. */
  private emulatorConsole(device: Device): EmulatorConsole {
    return (args, authorize) =>
      this.android.adb(device, args, 64 * 1024, authorize, 10_000).then(
        (output) => ({ code: output.code, stdout: output.stdout }),
        () => ({ code: 1, stdout: "" }),
      );
  }
  /** A booted Simulator's built-in screens, from devicectl; empty when it can't say. */
  async simulatorScreens(device: Device): Promise<SimulatorScreen[]> {
    if (device.platform !== "ios" || this.options.platform !== "darwin") return [];
    try {
      const { xcrun } = await this.xcode();
      const args = ["devicectl", "device", "info", "displays", "--device", nativeId(device)];
      const output = await this.run(xcrun, [...args, "--quiet", "--json-output", "-"], 256 * 1024);
      return readSimulatorScreens(JSON.parse(output.stdout));
    } catch {
      return [];
    }
  }
  private iosSimulators(authorize?: () => void) {
    const parse =
      devicePlatformBackend() === "native"
        ? (output: string) =>
            deviceAnswer<Simulator[]>(() => nativeDevices().devicePlatformSimulatorList(output))
        : undefined;
    return new Simulators(
      this.options.platform,
      async (command, args, probeOptions) => {
        const xcode = await this.xcode();
        authorize?.();
        return this.run(
          command === "xcrun" ? xcode.xcrun : xcode.open,
          args,
          probeOptions?.maxBytes,
          args.includes("boot") || args.includes("bootstatus") ? 240_000 : undefined,
          undefined,
          authorize,
        );
      },
      parse,
    );
  }

  protected xcode() {
    return resolveXcode({
      ...this.options,
      probe: (command, args, options) =>
        this.run(command, args, options?.maxBytes, options?.timeoutMs, options?.signal),
    });
  }
  async simulatorDevice(input: Device): Promise<Device> {
    return simulatorDevice(input, await this.simulators.list());
  }
  async simulatorCaptureDevice(input: Device): Promise<Device> {
    return simulatorIdentity(input, await this.simulators.list());
  }
  captureTransport(device: Device, expectedSerial?: string) {
    return this.android.captureTransport(device, expectedSerial);
  }
  watchCaptureTransport(device: Device, serial: string, fail: (error: DeviceError) => void) {
    return this.android.watchCaptureTransport(device, serial, fail);
  }
  get toolsDirectory(): string | undefined {
    return this.options.toolsDirectory;
  }
  /** The screen helper that encodes on the Mac's hardware (macOS only). */
  get frameEncoder(): string | undefined {
    return this.options.platform === "darwin" ? this.options.frameEncoder : undefined;
  }
  /**
   * How to encode an emulator's picture on the host, when it can be: a helper to encode with, a
   * place for the shared picture file, and the emulator's gRPC endpoint (one ace booted).
   */
  async hostEncoding(
    serial: string,
  ): Promise<{ grpc: EmulatorGrpc; encoder: string; directory: string } | undefined> {
    const { frameEncoder: encoder, toolsDirectory: directory } = this.options;
    const consolePort = emulatorConsolePort(serial);
    if (this.options.platform !== "darwin" || !encoder || !directory || consolePort === undefined)
      return undefined;
    const grpc = await emulatorGrpc(
      emulatorRunningDirectory({
        platform: this.options.platform,
        home: this.options.home,
        env: this.options.env,
      }),
      consolePort,
    );
    return grpc && { grpc, encoder, directory };
  }
  /** ace's own serve-sim, once the device tools are downloaded (Macs only). */
  async managedServeSim(): Promise<ServeSimCommand | undefined> {
    const { toolsDirectory: directory, node } = this.options;
    if (this.options.platform !== "darwin" || !directory || !node) return undefined;
    return managedServeSim({ directory, node });
  }
  /** What a tools download asks for; the native platform asks `ace-devices` instead. */
  protected toolsPlan(): { serveSim: boolean; scrcpy: boolean; timeoutMs: number } {
    return { serveSim: this.options.platform === "darwin", scrcpy: true, timeoutMs: 5 * 60_000 };
  }
  /**
   * Downloads the device tools ace runs (serve-sim on a Mac, the scrcpy server), in a process
   * of their own. Concurrent asks share one download; a finished one is reused.
   */
  downloadTools(runtime: Pick<DeviceRuntime, "spawn" | "after">): Promise<DeviceTools> {
    const { toolsDirectory: directory, node } = this.options;
    let plan: { serveSim: boolean; scrcpy: boolean; timeoutMs: number };
    try {
      // The plan's refusal comes first: with the switch on it is the platform's own word.
      plan = this.toolsPlan();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!directory || !node) return Promise.reject(catalogRefusal("toolsNowhere"));
    this.toolsDownload ??= downloadDeviceTools(
      { directory, node, runtime, env: this.options.env, timeoutMs: plan.timeoutMs },
      { serveSim: plan.serveSim, scrcpy: plan.scrcpy },
    ).finally(() => {
      this.toolsDownload = undefined;
      // The next inventory read looks for serve-sim again.
      this.checkedInput = false;
      this.inputHint = undefined;
    });
    return this.toolsDownload;
  }
  transportCommand(
    device: Device,
    serial: string,
    args: readonly string[],
    maxBytes?: number,
    timeoutMs?: number,
  ) {
    return this.android.transportCommand(device, serial, args, maxBytes, timeoutMs);
  }
  captureDimensions(device: Device): Promise<{ width: number; height: number }> {
    if (device.platform !== "android")
      throw new DeviceError(
        "not_supported",
        "Simulator dimensions come from its screen frame",
        "Start the Simulator view.",
      );
    return this.android.captureDimensions(device);
  }
  /** Whether this platform passes its injected clock to probes; only the native one does, so
   * the switch-off class keeps today's timers byte for byte. */
  protected nativeProbes(): boolean {
    return false;
  }
  /** The platform's injected clock, in the order `probeOutput` takes it. */
  private probeSchedule(): ((run: () => void, ms: number) => () => void) | undefined {
    const after = this.options.after;
    if (!this.nativeProbes() || after === undefined) return undefined;
    return (run, ms) => after(ms, run);
  }
  protected async run(
    command: string,
    args: readonly string[],
    maxBytes = 1024 * 1024,
    timeoutMs = 30_000,
    signal?: AbortSignal,
    authorize?: () => void,
  ) {
    if (this.controller.signal.aborted) throw catalogRefusal("deviceServiceClosed");
    if (this.active >= 8) {
      if (this.waiters.length >= 128)
        throw new DeviceError(
          "busy",
          "Device command queue is full",
          "Wait for pending device actions.",
        );
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else this.active++;
    try {
      this.controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      authorize?.();
      const output = await this.probe(command, args, {
        env: this.options.env,
        maxBytes,
        timeoutMs,
        signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
      });
      if (output.code !== 0)
        throw new DeviceError(
          "command_failed",
          "Device command failed",
          "Check the SDK tool and device logs, then retry.",
        );
      return output;
    } catch (error) {
      if (error instanceof DeviceError) throw error;
      throw new DeviceError(
        error instanceof Error && error.message === "Probe timed out"
          ? "timeout"
          : "command_failed",
        "Device command could not complete",
        "Check the SDK installation and device connection, then retry.",
      );
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
  /** Host platform, home, and env used by native inventory watchers (D2). */
  inventoryWatchConfig(): {
    platform: string;
    home: string;
    env: Readonly<Record<string, string | undefined>>;
  } {
    return {
      platform: this.options.platform,
      home: this.options.home,
      env: this.options.env,
    };
  }
  /** The iOS inventory read; the native platform replaces the record mapping, not the probe. */
  protected async readIosSource(): Promise<Device[]> {
    return (await this.simulators.list()).map((device) =>
      DeviceSchema.parse({
        id: `ios:${device.udid}`,
        platform: "ios",
        name: device.name,
        state: device.state === "Booted" ? "booted" : "shutdown",
        runtime: simulatorRuntime(device.runtime),
        ...(device.deviceTypeIdentifier ? { model: device.deviceTypeIdentifier } : {}),
      }),
    );
  }
  /** Whether `listSource(scope)` re-reads only that source (D2's scoped inventory). */
  scopedListing(): boolean {
    return this.list === DevicePlatformBase.prototype.list;
  }
  /** Remember one source's read, so a scoped trigger can compose it with the other. */
  protected recordOutcome(
    platform: Device["platform"],
    result: PromiseSettledResult<Device[]>,
  ): void {
    if (platform === "ios") this.lastIosOutcome = result;
    else this.lastAndroidOutcome = result;
  }
  private async settleOutcome(read: Promise<Device[]>): Promise<PromiseSettledResult<Device[]>> {
    const [result] = await Promise.allSettled([read]);
    return result as PromiseSettledResult<Device[]>;
  }
  private async finalizeList(
    entries: { platform: Device["platform"]; result: PromiseSettledResult<Device[]> }[],
  ): Promise<Device[]> {
    const devices: Device[] = [];
    const missing: (DeviceFailure & { platform: Device["platform"] })[] = [];
    for (const { platform, result } of entries) {
      if (result.status === "fulfilled") devices.push(...result.value);
      else if (result.reason instanceof DeviceError && result.reason.code === "sdk_missing") {
        const { code, message, hint } = result.reason;
        missing.push({ code, message, hint, platform });
      } else throw result.reason;
    }
    this.setMissingSDKs(missing);
    const adopted = this.adoptInventory(devices);
    if (adopted) await adopted;
    // Every platform's SDK is missing: the inventory itself fails (no other error got here).
    const first = entries[0]?.result;
    if (
      first?.status === "rejected" &&
      entries.every((entry) => entry.result.status === "rejected")
    )
      throw first.reason;
    return devices;
  }
  /** Re-reads only the triggered list (`ios`, `avds`, or `adb`) when cached peers exist (D2). */
  setInventoryListGuard(guard: (<T>(read: () => Promise<T>) => Promise<T>) | undefined): void {
    this.android.setListGuard(guard);
  }
  invalidateAndroidIdentityCache(): void {
    if (deviceInventoryBackend() === "native") this.android.invalidateIdentityCache();
  }
  async listSource(scope: "all" | "ios" | "avds" | "adb"): Promise<Device[]> {
    if (scope === "all" || !this.scopedListing()) return this.list();
    if (scope === "ios") {
      if (this.options.platform !== "darwin" || this.lastAndroidOutcome === undefined)
        return this.list();
      const ios = await this.settleOutcome(this.readIosSource());
      this.recordOutcome("ios", ios);
      return this.finalizeList([
        { platform: "ios", result: ios },
        { platform: "android", result: this.lastAndroidOutcome },
      ]);
    }
    if (this.options.platform === "darwin" && this.lastIosOutcome === undefined) return this.list();
    const android = await this.settleOutcome(this.android.list(scope));
    this.recordOutcome("android", android);
    return this.finalizeList(
      this.options.platform === "darwin" && this.lastIosOutcome !== undefined
        ? [
            { platform: "ios", result: this.lastIosOutcome },
            { platform: "android", result: android },
          ]
        : [{ platform: "android", result: android }],
    );
  }
  private async listNative(): Promise<Device[]> {
    const sources: { platform: Device["platform"]; read: Promise<Device[]> }[] =
      this.options.platform === "darwin"
        ? [
            { platform: "ios", read: this.readIosSource() },
            { platform: "android", read: this.android.list("all") },
          ]
        : [{ platform: "android", read: this.android.list("all") }];
    const outcomes = await Promise.allSettled(sources.map((source) => source.read));
    const entries = sources.map((source, index) => ({
      platform: source.platform,
      result: outcomes[index] as PromiseSettledResult<Device[]>,
    }));
    for (const entry of entries) this.recordOutcome(entry.platform, entry.result);
    return this.finalizeList(entries);
  }
  async list(): Promise<Device[]> {
    if (deviceInventoryBackend() === "native") return this.listNative();
    const sources: { platform: Device["platform"]; read: Promise<Device[]> }[] =
      this.options.platform === "darwin"
        ? [
            { platform: "ios", read: this.readIosSource() },
            { platform: "android", read: this.android.list("all") },
          ]
        : [{ platform: "android", read: this.android.list("all") }];
    const outcomes = await Promise.allSettled(sources.map((source) => source.read));
    for (const [index, result] of outcomes.entries())
      this.recordOutcome(sources[index]?.platform ?? "android", result);
    const devices: Device[] = [];
    const missing: (DeviceFailure & { platform: Device["platform"] })[] = [];
    for (const [index, result] of outcomes.entries()) {
      if (result.status === "fulfilled") devices.push(...result.value);
      else if (result.reason instanceof DeviceError && result.reason.code === "sdk_missing") {
        const { code, message, hint } = result.reason;
        missing.push({ code, message, hint, platform: sources[index]?.platform ?? "android" });
      } else throw result.reason;
    }
    this.setMissingSDKs(missing);
    const adopted = this.adoptInventory(devices);
    if (adopted) await adopted;
    // Every platform's SDK is missing: the inventory itself fails (no other error got here).
    const [first] = outcomes;
    if (first?.status === "rejected" && outcomes.every((result) => result.status === "rejected"))
      throw first.reason;
    return devices;
  }
  /** The missing SDKs the last read found, as `diagnostics` shows them. */
  protected setMissingSDKs(missing: (DeviceFailure & { platform: Device["platform"] })[]): void {
    this.missingSDKs = missing;
  }
  /** What every platform's list does after the reads: forget gone processes, notice a missing
   * serve-sim the first time an iOS device appears. Synchronous unless that check must run. */
  protected adoptInventory(devices: readonly Device[]): void | Promise<void> {
    const present = new Set(
      devices.filter((device) => device.state === "booted").map((device) => device.id),
    );
    for (const id of this.appProcesses.keys()) if (!present.has(id)) this.appProcesses.delete(id);
    if (this.checkedInput || !devices.some((device) => device.platform === "ios")) return;
    return this.inspectInputTools();
  }
  private async inspectInputTools(): Promise<void> {
    const [managed, serve, idb] = await Promise.all([
      this.managedServeSim(),
      findExecutable(this.options.env["ACE_SERVE_SIM"] ?? "serve-sim", this.options.env),
      findExecutable("idb", this.options.env),
    ]);
    this.checkedInput = true;
    if (!managed && !serve && !idb)
      this.inputHint = new DeviceError(
        "tool_missing",
        "The Simulator's device tools aren't downloaded",
        "Download device tools in Devices: ace's serve-sim streams the Simulator and takes its gestures, typing and keys.",
      );
  }

  protected async simctl(
    device: Device,
    args: readonly string[],
    authorize?: () => void,
    timeoutMs?: number,
  ) {
    const { xcrun } = await this.xcode();
    authorize?.();
    return this.run(
      xcrun,
      ["simctl", ...args.slice(0, 1), nativeId(device), ...args.slice(1)],
      undefined,
      timeoutMs,
      undefined,
      authorize,
    );
  }
  async boot(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform === "ios") await this.iosSimulators(authorize).boot(nativeId(device));
    else await this.android.boot(device, authorize);
  }
  /** How an agent's screenshot is fitted to the model: through ace-media (ADR 0208). */
  modelImages(): ModelImageRuntime {
    return modelImageRuntime(this.images);
  }
  /** One still of the screen, for when no live view is running. */
  screenshot(device: Device, authorize?: () => void): Promise<DeviceShot> {
    return deviceScreenshot(
      device,
      {
        simulator: async (path) => {
          await this.simctl(device, ["io", "screenshot", "--type=png", path], authorize);
        },
        emulator: (path) =>
          emulatorScreenshot(
            (args, maxBytes) => this.android.adb(device, args, maxBytes, authorize),
            path,
          ),
      },
      this.images,
    );
  }
  /** Without a live view's control channel: the Simulator pasteboard through simctl. */
  async clipboardRead(device: Device, authorize?: () => void): Promise<ClipboardRead> {
    return simulatorPaste(await this.pasteboard(device, authorize));
  }
  async clipboardWrite(device: Device, text: string, authorize?: () => void): Promise<void> {
    await simulatorCopy(await this.pasteboard(device, authorize), text);
  }
  private async pasteboard(device: Device, authorize?: () => void) {
    if (device.platform === "android") throw androidClipboardUnavailable();
    const { xcrun } = await this.xcode();
    authorize?.();
    return {
      spawn: this.options.spawnRaw ?? spawnRawSupervised,
      xcrun,
      udid: nativeId(device),
      env: this.options.env,
      after:
        this.options.after ??
        ((ms: number, run: () => void) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        }),
    };
  }
  /** Make sure Simulator shows this booted device's window, without taking focus. */
  async showSimulator(device: Device): Promise<void> {
    if (device.platform === "ios") await this.iosSimulators().show(nativeId(device));
  }
  async shutdown(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform === "ios") {
      await this.simctl(device, ["shutdown"], authorize);
      this.appProcesses.delete(device.id);
    } else await this.android.shutdown(device, authorize);
  }
  async install(device: Device, input: string, authorize?: () => void): Promise<void> {
    const path = Text.refine(isAbsolute).parse(input);
    if (device.platform === "ios") {
      if (extname(path) !== ".app") throw catalogRefusal("installSimulatorApp");
      await this.simctl(device, ["install", path], authorize, deviceInstallTimeoutMs);
    } else {
      if (extname(path) !== ".apk") throw catalogRefusal("installAndroidApk");
      await this.android.adb(
        device,
        ["install", "-r", path],
        undefined,
        authorize,
        deviceInstallTimeoutMs,
      );
    }
  }
  async openApp(device: Device, input: string, authorize?: () => void): Promise<void> {
    const app = AppId.parse(input);
    if (device.platform === "ios") {
      const result = await this.simctl(device, ["launch", app], authorize);
      const pid = /:\s*(\d+)\s*$/.exec(result.stdout)?.[1];
      if (pid) this.appProcesses.set(device.id, pid);
      return;
    }
    if (app.includes("/"))
      await this.android.adb(device, adbShell(["am", "start", "-n", app]), undefined, authorize);
    else {
      const resolved = await this.android.adb(
        device,
        adbShell([
          "cmd",
          "package",
          "resolve-activity",
          "--brief",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
          app,
        ]),
        8192,
      );
      const component = resolved.stdout.split("\n").find((line) => line.includes("/"));
      if (!component || !AppId.safeParse(component).success)
        throw catalogRefusal("appNotLaunchable");
      await this.android.adb(
        device,
        adbShell(["am", "start", "-n", component]),
        undefined,
        authorize,
      );
    }
  }
  async openUrl(device: Device, input: string, authorize?: () => void): Promise<void> {
    const url = Text.refine((value) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)).parse(input);
    if (device.platform === "ios") await this.simctl(device, ["openurl", url], authorize);
    else
      await this.android.adb(
        device,
        adbShell(["am", "start", "-a", "android.intent.action.VIEW", "-d", url]),
        undefined,
        authorize,
      );
  }
  async configure(device: Device, input: DeviceSettings, authorize?: () => void): Promise<void> {
    const settings = Settings.parse(input);
    if (settings.locale) throw catalogRefusal("localeUnsupported");
    if (device.platform === "ios") {
      if (settings.appearance)
        await this.simctl(device, ["ui", "appearance", settings.appearance], authorize);
      if (settings.location)
        await this.simctl(
          device,
          ["location", "set", `${settings.location.latitude},${settings.location.longitude}`],
          authorize,
        );
    } else {
      if (settings.appearance)
        await this.android.adb(
          device,
          adbShell(["cmd", "uimode", "night", settings.appearance === "dark" ? "yes" : "no"]),
          undefined,
          authorize,
        );
      if (settings.location && this.android.physical(device.id))
        throw catalogRefusal("locationPhysical");
      if (settings.location)
        await this.android.adb(
          device,
          [
            "emu",
            "geo",
            "fix",
            String(settings.location.longitude),
            String(settings.location.latitude),
          ],
          undefined,
          authorize,
        );
    }
  }
  async input(
    device: Device,
    raw: DeviceInput,
    binding?: ScreenBinding,
    authorize?: () => void,
  ): Promise<void> {
    const input = InputSchema.parse(raw);
    if (device.platform === "android") {
      if (input.kind === "key" && input.key === "rotate") {
        const { stdout } = await this.android.adb(
          device,
          adbShell(["settings", "get", "system", "user_rotation"]),
          4096,
          authorize,
        );
        const rotation = z.coerce.number().int().min(0).max(3).parse(stdout);
        await this.android.adb(
          device,
          adbShell(["wm", "user-rotation", "lock", String((rotation + 1) % 4)]),
          undefined,
          authorize,
        );
      } else
        await this.android.input(
          device,
          androidInput(input),
          authorize ?? (() => {}),
          deviceInputTimeout(input),
        );
      return;
    }
    // Native device HID keeps Simulator behind ace when idb is installed.
    const hid = simulatorHID(input);
    if (hid) {
      const idb = await findExecutable("idb", this.options.env);
      if (idb) {
        authorize?.();
        await this.run(
          idb,
          [...hid, "--udid", nativeId(device)],
          undefined,
          deviceInputTimeout(input),
          undefined,
          authorize,
        );
        return;
      }
    }
    if (
      (input.kind === "swipe" || input.kind === "longPress") &&
      (!binding || !this.options.screen)
    ) {
      const idb = await findExecutable("idb", this.options.env);
      if (!idb)
        throw new DeviceError(
          "tool_missing",
          "Simulator gestures require idb",
          "Install idb and idb_companion, or use semantic UI actions through the Simulator window.",
        );
      const args =
        input.kind === "swipe"
          ? [
              "ui",
              "swipe",
              String(input.x),
              String(input.y),
              String(input.toX),
              String(input.toY),
              "--duration",
              String(input.durationMs / 1000),
            ]
          : [
              "ui",
              "tap",
              String(input.x),
              String(input.y),
              "--duration",
              String(input.durationMs / 1000),
            ];
      authorize?.();
      await this.run(
        idb,
        [...args, "--udid", nativeId(device)],
        undefined,
        deviceInputTimeout(input),
        undefined,
        authorize,
      );
      return;
    }
    if (!binding || !this.options.screen)
      throw new DeviceError(
        "lease_required",
        "Simulator window control is required",
        "Start the Simulator view and take control.",
      );
    const button = simulatorButton(input);
    if (button) {
      authorize?.();
      await this.options.screen.pressButton(
        binding.sessionId,
        binding.actor,
        button,
        binding.owner,
        authorize,
      );
      return;
    }
    const mapped = simulatorInput(input);
    authorize?.();
    await this.options.screen.input(
      binding.sessionId,
      binding.actor,
      mapped,
      binding.owner,
      authorize,
    );
  }
  uiTree(device: Device, options: unknown) {
    return this.androidUI.tree(device, options);
  }
  uiFind(device: Device, options: unknown) {
    return this.androidUI.find(device, options);
  }
  uiAct(device: Device, options: unknown, authorize?: () => void) {
    return this.androidUI.act(device, options, authorize);
  }
  async logs(device: Device): Promise<{ command: string; args: string[] }> {
    if (device.platform === "ios") {
      const { xcrun } = await this.xcode();
      return {
        command: xcrun,
        args: [
          "simctl",
          "spawn",
          nativeId(device),
          "log",
          "stream",
          "--style",
          "ndjson",
          "--level",
          "info",
          "--predicate",
          this.appProcesses.has(device.id)
            ? `processIdentifier == ${this.appProcesses.get(device.id)}`
            : 'process != "log" AND process != "SpringBoard" AND process != "runningboardd" AND process != "backboardd"',
        ],
      };
    }
    return this.android.logs(device);
  }

  async close(): Promise<void> {
    this.controller.abort();
    this.appProcesses.clear();
    await this.android.close();
  }
}
