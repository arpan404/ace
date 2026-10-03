import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { Simulators, type ScreenManager } from "@ace/screen";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { findExecutable } from "@ace/provider-kit/discovery";
import {
  AppDevice as DeviceSchema,
  DeviceInput as InputSchema,
  type AppDevice as Device,
  type DeviceInput,
  DeviceSettings as Settings,
  type DeviceSettings,
} from "@ace/protocol/devices";
import { ScreenUIActOptions, ScreenUIFindOptions, type ScreenInput } from "@ace/protocol";
import { DeviceError, resolveXcode, type SDKOptions } from "./sdk.ts";
import { adbShell, androidInput, nativeId } from "./commands.ts";
import { androidTree, androidFind, androidTarget } from "./android-ui.ts";
import { AndroidPlatform } from "./android-platform.ts";

export type PlatformOptions = SDKOptions & {
  spawn?: typeof spawnSupervised;
  screen?: ScreenManager;
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
  private readonly controller = new AbortController();
  private missingSDKs: DeviceError[] = [];
  diagnostics(): { code: string; message: string; hint: string }[] {
    return this.missingSDKs.map(({ code, message, hint }) => ({ code, message, hint }));
  }
  constructor(options: PlatformOptions) {
    this.options = options;
    this.probe = options.probe ?? probeOutput;
    this.android = new AndroidPlatform(
      options,
      (command, args, maxBytes, timeoutMs, signal) =>
        this.run(command, args, maxBytes, timeoutMs, signal),
      options.spawn ?? spawnSupervised,
    );
    this.simulators = this.iosSimulators();
  }
  private iosSimulators(authorize?: () => void) {
    return new Simulators(this.options.platform, async (command, args, probeOptions) => {
      const xcode = await this.xcode();
      authorize?.();
      return this.run(command === "xcrun" ? xcode.xcrun : xcode.open, args, probeOptions?.maxBytes);
    });
  }

  private xcode() {
    return resolveXcode({
      ...this.options,
      probe: (command, args, options) =>
        this.run(command, args, options?.maxBytes, options?.timeoutMs, options?.signal),
    });
  }
  resolveAndroid() {
    return this.android.resolve();
  }
  captureDimensions(device: Device): Promise<{ width: number; height: number }> {
    if (device.platform !== "android")
      throw new DeviceError(
        "not_supported",
        "Simulator dimensions come from its screen frame",
        "Start the approved Simulator view.",
      );
    return this.android.captureDimensions(device);
  }
  private async run(
    command: string,
    args: readonly string[],
    maxBytes = 1024 * 1024,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ) {
    if (this.controller.signal.aborted)
      throw new DeviceError(
        "command_failed",
        "Device service is closed",
        "Restart the device service.",
      );
    if (this.active >= 8)
      throw new DeviceError(
        "busy",
        "Device command concurrency limit",
        "Wait for another device operation to finish.",
      );
    this.active++;
    try {
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
      this.active--;
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
          runtime: device.runtime,
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
    if (missing.length && outcomes.every((result) => result.status === "rejected"))
      throw missing[0];
    return devices;
  }
  private async simctl(device: Device, args: readonly string[], authorize?: () => void) {
    const { xcrun } = await this.xcode();
    authorize?.();
    return this.run(xcrun, ["simctl", ...args.slice(0, 1), nativeId(device), ...args.slice(1)]);
  }
  async boot(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform === "ios") await this.iosSimulators(authorize).boot(nativeId(device));
    else await this.android.boot(device, authorize);
  }
  async shutdown(device: Device, authorize?: () => void): Promise<void> {
    if (device.platform === "ios") await this.simctl(device, ["shutdown"], authorize);
    else await this.android.shutdown(device, authorize);
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
      await this.simctl(device, ["install", path], authorize);
    } else {
      if (extname(path) !== ".apk")
        throw new DeviceError(
          "invalid_data",
          "Android install requires an .apk",
          "Select an APK built for the emulator architecture.",
        );
      await this.android.adb(device, ["install", "-r", path], undefined, authorize);
    }
  }
  async openApp(device: Device, input: string, authorize?: () => void): Promise<void> {
    const app = AppId.parse(input);
    if (device.platform === "ios") {
      await this.simctl(device, ["launch", app], authorize);
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
      } else await this.android.adb(device, androidInput(input), undefined, authorize);
      return;
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
      await this.run(idb, [...args, "--udid", nativeId(device)]);
      return;
    }
    if (!binding || !this.options.screen)
      throw new DeviceError(
        "lease_required",
        "Simulator window control is required",
        "Start the approved Simulator view and take control.",
      );
    let mapped: ScreenInput;
    if (input.kind === "swipe" || input.kind === "longPress")
      mapped = {
        kind: "pointer.drag",
        x: input.x,
        y: input.y,
        toX: input.kind === "swipe" ? input.toX : input.x,
        toY: input.kind === "swipe" ? input.toY : input.y,
        durationMs: input.durationMs,
        button: "left",
      };
    else if (input.kind === "tap")
      mapped = { kind: "pointer.click", x: input.x, y: input.y, button: "left" };
    else if (input.kind === "type") mapped = { kind: "text.type", text: input.text };
    else if (input.key === "home")
      mapped = { kind: "key.press", key: "h", modifiers: ["command", "shift"] };
    else if (input.key === "rotate")
      mapped = { kind: "key.press", key: "right", modifiers: ["command"] };
    else if (input.key === "enter") mapped = { kind: "key.press", key: "Return", modifiers: [] };
    else
      throw new DeviceError(
        "not_supported",
        "This hardware key is not supported by iOS Simulator",
        "Use the Simulator Device menu or the app's navigation.",
      );
    authorize?.();
    await this.options.screen.input(
      binding.sessionId,
      binding.actor,
      mapped,
      binding.owner,
      authorize,
    );
  }
  async uiTree(device: Device, options: unknown) {
    if (device.platform !== "android")
      throw new DeviceError(
        "not_supported",
        "Simulator tree uses the approved screen session",
        "Use the device service's Simulator tree operation.",
      );
    const path = "/data/local/tmp/ace-ui.xml";
    await this.android.adb(device, adbShell(["uiautomator", "dump", path]), 8192);
    const result = await this.android.adb(device, ["exec-out", "cat", path], 1024 * 1024);
    return androidTree(result.stdout, options);
  }
  async uiFind(device: Device, options: unknown) {
    ScreenUIFindOptions.parse(options);
    return androidFind(await this.uiTree(device, { maxNodes: 512, maxDepth: 16 }), options);
  }
  async uiAct(device: Device, raw: unknown, authorize?: () => void) {
    const action = ScreenUIActOptions.parse(raw);
    const node = androidTarget(
      await this.uiTree(device, { maxNodes: 512, maxDepth: 16 }),
      action.ref,
    );
    if (
      !node.actions.includes(action.action) ||
      node.states.includes("disabled") ||
      !node.bounds.w ||
      !node.bounds.h
    )
      throw new DeviceError(
        "not_supported",
        "Android UI target does not support this action",
        "Read supported actions from the current tree.",
      );
    if (
      action.action === "select" &&
      typeof action.value === "boolean" &&
      (node.states.includes("checked") || node.states.includes("selected")) === action.value
    )
      return { fallback: false, method: "already_selected" };
    const centre = {
      x: Math.floor(node.bounds.x + node.bounds.w / 2),
      y: Math.floor(node.bounds.y + node.bounds.h / 2),
    };
    if (action.action === "scroll") {
      const scroll = z
        .object({
          dx: z.number().int().min(-1000).max(1000).default(0),
          dy: z.number().int().min(-1000).max(1000).default(0),
        })
        .parse(action.value ?? {});
      if (scroll.dx === 0 && scroll.dy === 0) return { fallback: false, method: "no_scroll" };
      const toX = Math.max(
        node.bounds.x,
        Math.min(node.bounds.x + node.bounds.w - 1, centre.x - scroll.dx),
      );
      const toY = Math.max(
        node.bounds.y,
        Math.min(node.bounds.y + node.bounds.h - 1, centre.y - scroll.dy),
      );
      await this.input(
        device,
        { kind: "swipe", ...centre, toX, toY, durationMs: 300 },
        undefined,
        authorize,
      );
    } else await this.input(device, { kind: "tap", ...centre }, undefined, authorize);
    return { fallback: true, method: "adb.shell.input", boundsCentre: centre };
  }
  async logs(device: Device): Promise<{ command: string; args: string[] }> {
    if (device.platform === "ios") {
      const { xcrun } = await this.xcode();
      return {
        command: xcrun,
        args: ["simctl", "spawn", nativeId(device), "log", "stream", "--style", "ndjson"],
      };
    }
    return this.android.logs(device);
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.android.close();
  }
}
