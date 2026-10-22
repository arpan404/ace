import { deviceInputTimeout } from "./input-budget.ts";
import { deviceInstallTimeoutMs } from "./action-budget.ts";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { Simulators, type ScreenManager } from "@ace/screen";
import { probeOutput, spawnRawSupervised, spawnSupervised } from "@ace/provider-kit/process";
import { findExecutable } from "@ace/provider-kit/discovery";
import {
  AppDevice as DeviceSchema,
  DeviceInput as InputSchema,
  type AppDevice as Device,
  type DeviceInput,
  DeviceSettings as Settings,
  type DeviceSettings,
  type DeviceFailure,
} from "@ace/protocol/devices";
import { DeviceError, resolveXcode, type SDKOptions } from "./sdk.ts";
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
};
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

export class DevicePlatform {
  private readonly options: PlatformOptions;
  private readonly probe: typeof probeOutput;
  private readonly simulators: Simulators;
  private readonly android: AndroidPlatform;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly controller = new AbortController();
  private readonly androidUI: AndroidOperations;
  private missingSDKs: DeviceError[] = [];
  private inputHint: DeviceError | undefined;
  private checkedInput = false;
  private toolsDownload: Promise<DeviceTools> | undefined;
  private readonly appProcesses = new Map<string, string>();
  diagnostics(): DeviceFailure[] {
    return [
      ...this.missingSDKs,
      ...this.android.diagnostics(),
      ...(this.inputHint ? [this.inputHint] : []),
    ]
      .slice(0, 2)
      .map(({ code, message, hint }) => ({ code, message, hint }));
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
  }
  private iosSimulators(authorize?: () => void) {
    return new Simulators(this.options.platform, async (command, args, probeOptions) => {
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
    });
  }

  private xcode() {
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
  /**
   * Downloads the device tools ace runs (serve-sim on a Mac, the scrcpy server), in a process
   * of their own. Concurrent asks share one download; a finished one is reused.
   */
  downloadTools(runtime: Pick<DeviceRuntime, "spawn" | "after">): Promise<DeviceTools> {
    const { toolsDirectory: directory, node } = this.options;
    if (!directory || !node)
      return Promise.reject(
        new DeviceError(
          "tool_missing",
          "ace has nowhere to keep device tools",
          "Restart ace; its home directory should hold them.",
        ),
      );
    this.toolsDownload ??= downloadDeviceTools(
      { directory, node, runtime, env: this.options.env },
      { serveSim: this.options.platform === "darwin", scrcpy: true },
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
  private async run(
    command: string,
    args: readonly string[],
    maxBytes = 1024 * 1024,
    timeoutMs = 30_000,
    signal?: AbortSignal,
    authorize?: () => void,
  ) {
    if (this.controller.signal.aborted)
      throw new DeviceError(
        "command_failed",
        "Device service is closed",
        "Restart the device service.",
      );
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
  async list(): Promise<Device[]> {
    const ios = async (): Promise<Device[]> =>
      (await this.simulators.list()).map((device) =>
        DeviceSchema.parse({
          id: `ios:${device.udid}`,
          platform: "ios",
          name: device.name,
          state: device.state === "Booted" ? "booted" : "shutdown",
          runtime: simulatorRuntime(device.runtime),
        }),
      );
    const outcomes = await Promise.allSettled(
      this.options.platform === "darwin" ? [ios(), this.android.list()] : [this.android.list()],
    );
    const devices: Device[] = [];
    const missing: DeviceError[] = [];
    for (const result of outcomes) {
      if (result.status === "fulfilled") devices.push(...result.value);
      else if (result.reason instanceof DeviceError && result.reason.code === "sdk_missing")
        missing.push(result.reason);
      else throw result.reason;
    }
    this.missingSDKs = missing;
    const present = new Set(
      devices.filter((device) => device.state === "booted").map((device) => device.id),
    );
    for (const id of this.appProcesses.keys()) if (!present.has(id)) this.appProcesses.delete(id);
    if (!this.checkedInput && devices.some((device) => device.platform === "ios")) {
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
    if (missing.length && outcomes.every((result) => result.status === "rejected"))
      throw missing[0];
    return devices;
  }
  private async simctl(
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
  /** One still of the screen, for when no live view is running. */
  screenshot(device: Device, authorize?: () => void): Promise<DeviceShot> {
    return deviceScreenshot(device, {
      simulator: async (path) => {
        await this.simctl(device, ["io", "screenshot", "--type=png", path], authorize);
      },
      emulator: (path) =>
        emulatorScreenshot(
          (args, maxBytes) => this.android.adb(device, args, maxBytes, authorize),
          path,
        ),
    });
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
      if (extname(path) !== ".app")
        throw new DeviceError(
          "not_supported",
          "iOS Simulator installs Simulator-built .app bundles",
          "Extract a Simulator-built .app from the IPA; device-only IPA binaries cannot run in Simulator.",
        );
      await this.simctl(device, ["install", path], authorize, deviceInstallTimeoutMs);
    } else {
      if (extname(path) !== ".apk")
        throw new DeviceError(
          "invalid_data",
          "Android install requires an .apk",
          "Select an APK built for the emulator architecture.",
        );
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
        throw new DeviceError(
          "not_found",
          "Android app has no launchable activity",
          "Supply a package/activity component or install the app first.",
        );
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
    if (settings.locale)
      throw new DeviceError(
        "not_supported",
        "Runtime locale configuration is not supported by the installed public CLI contract",
        "Change language in the device Settings app, then restart the app.",
      );
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
        throw new DeviceError(
          "not_supported",
          "Only an emulator's location can be set",
          "Use a mock location app on the device, or set the location on an emulator.",
        );
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
