import { simulatorCapture } from "./simulator-capture.ts";
import type { DeviceInput } from "@ace/protocol/devices";
import { deviceWindowBundles, type Frame, type ScreenManager, ScreenStopError } from "@ace/screen";
import type { ScreenStreamSettings, ScreenAgentScope } from "@ace/protocol";
import type { AppDevice as Device } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";
import { screenrecordCapture } from "./android-screenrecord.ts";
import { scrcpyCapture } from "./scrcpy-capture.ts";
import { installedScrcpyJar } from "./scrcpy-jar.ts";
import type { DevicePlatform } from "./platform.ts";
import type { Capture, DeviceRuntime } from "./runtime.ts";
import { permissionDenied } from "./screen-failure.ts";
import type { CaptureUI } from "./simulator-ui.ts";
import type { DeviceClipboard } from "./clipboard.ts";
import { pinnedServeSim, serveSimStatus } from "./serve-sim-version.ts";
import { replaceOutdatedHelper } from "./serve-sim-helpers.ts";
import { nativeId } from "./commands.ts";

export interface DeviceCapture extends Capture {
  releaseInput?(): Promise<void>;
  input?(input: DeviceInput, guard: () => void): Promise<void>;
  screenSessionId?: string;
  streamId?: string;
  configure?(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }>;
  keyframe?(): Promise<void>;
  /** Pointer input may carry fingers other than the first. */
  readonly multiTouch?: boolean;
  /** Accessibility served by the capture's own transport rather than the screen helper. */
  ui?: CaptureUI;
  /** The device clipboard over the capture's own control channel. */
  clipboard?: DeviceClipboard;
  /** The picture shows the device's own body, as a Simulator window does: draw no frame. */
  readonly framed?: boolean;
}
export async function startCapture(options: {
  device: Device;
  scope?: ScreenAgentScope;
  streamId: string;
  fps: number;
  platform: DevicePlatform;
  screen?: ScreenManager;
  runtime: DeviceRuntime;
  env: NodeJS.ProcessEnv;
  publish(frame: Frame): void;
  failure(error: unknown): void;
  signal?: AbortSignal;
}): Promise<DeviceCapture> {
  const checkAbort = () => {
    if (options.signal?.aborted)
      throw new DOMException("Device capture startup cancelled", "AbortError");
  };
  checkAbort();
  if (options.device.platform === "ios") {
    let status = await serveSimStatus(
      options.env,
      options.runtime,
      await options.platform.managedServeSim(),
    );
    checkAbort();
    // ace's own serve-sim is downloaded on first use, as the scrcpy server is.
    if (!status.supported && !options.env["ACE_SERVE_SIM"]) {
      const tools = await options.platform.downloadTools(options.runtime).catch(() => undefined);
      checkAbort();
      if (tools?.serveSim)
        status = await serveSimStatus(options.env, options.runtime, tools.serveSim);
      checkAbort();
    }
    const { command, version, supported } = status;
    if (command && supported) {
      const device = await options.platform.simulatorDevice(options.device);
      checkAbort();
      if (version)
        await replaceOutdatedHelper({
          command,
          args: status.args,
          version,
          udid: nativeId(device),
          env: options.env,
          runtime: options.runtime,
        });
      checkAbort();
      const transcoder = options.platform.frameEncoder;
      return simulatorCapture({
        ...options,
        device,
        command,
        commandArgs: status.args,
        ...(transcoder ? { transcoder } : {}),
      });
    }
    // serve-sim is preferred; an unpinned version falls back to the public-API screen helper.
    const unpinned = command
      ? new DeviceError(
          "tool_missing",
          `serve-sim ${version ?? "(unknown version)"} isn't a version ace supports`,
          `Download device tools in Devices for ace's serve-sim ${pinnedServeSim}, or unset ACE_SERVE_SIM.`,
        )
      : undefined;
    if (options.env["ACE_SERVE_SIM"])
      throw (
        unpinned ??
        new DeviceError(
          "tool_missing",
          "serve-sim was not found",
          "Correct ACE_SERVE_SIM, or unset it to use ace's own serve-sim.",
        )
      );
    const screen = options.screen;
    if (!screen)
      throw (
        unpinned ??
        new DeviceError(
          "tool_missing",
          "Screen helper is not configured",
          "Configure ACE_SCREEN_HELPER and grant Screen Recording and Accessibility permissions.",
        )
      );
    // Say plainly when macOS hasn't let the helper see the screen, before looking for windows.
    const permissions = await screen.inspectDevicePermissions();
    checkAbort();
    if (!permissions.screenRecording) throw permissionDenied("screenRecording");
    const selected = await options.platform.simulatorCaptureDevice(options.device);
    checkAbort();
    const window = await simulatorWindow(screen, options, selected.name, checkAbort);
    const confirmed = await options.platform.simulatorCaptureDevice(selected);
    checkAbort();
    if (confirmed.name !== selected.name)
      throw new DeviceError(
        "busy",
        "Simulator changed while selecting its window",
        "Refresh the device list and start capture again.",
      );
    // The device alone: the window's title bar and toolbar are cropped off by the helper,
    // which takes pointer input in points from the top of what it shows.
    const target = {
      kind: "window" as const,
      bundleId: window.bundleId,
      windowId: window.windowId,
      content: true,
    };
    const state = options.scope
      ? await screen.start(target, options.fps, options.scope)
      : await screen.startHumanDeviceView(target, options.fps);
    let stopped = false;
    let terminated = false;
    let stopping: Promise<void> | undefined;
    let unwatch: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = (): Promise<void> => {
      if (terminated) return Promise.resolve();
      stopping ??= Promise.resolve()
        .then(async () => {
          stopped = true;
          const errors: unknown[] = [];
          for (const release of [unsubscribe, unwatch]) {
            try {
              release?.();
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await screen.stop(state.sessionId);
            terminated = true;
          } catch (error) {
            if (error instanceof ScreenStopError && error.captureTerminated) terminated = true;
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length) throw new AggregateError(errors, "Simulator capture cleanup failed");
        })
        .finally(() => {
          stopping = undefined;
        });
      return stopping;
    };
    try {
      checkAbort();
      unwatch = screen.watch((next) => {
        if (
          next.sessionId === state.sessionId &&
          ["failed", "stopped"].includes(next.lifecycle) &&
          !stopped
        )
          options.failure(new Error(next.error ?? "Simulator capture ended"));
      });
      unsubscribe = screen.subscribe(state.sessionId, async (frame) => {
        // Keep the native session identity so forwarding never copies image bytes.
        options.publish(frame);
      });
      return {
        screenSessionId: state.sessionId,
        streamId: state.sessionId,
        framed: true,
        async configure(settings) {
          const result = await screen.configureStream(state.sessionId, settings);
          // The screen helper encodes H.264 only where macOS lets it; serve-sim always does.
          if (settings.codec === "h264" && result.codec !== "h264")
            throw new DeviceError(
              "tool_missing",
              "This Mac's screen helper can't stream video for the Simulator live view",
              `Download device tools in Devices for ace's serve-sim ${pinnedServeSim}.`,
            );
          return result;
        },
        keyframe: () => screen.requestKeyframe(state.sessionId),
        stop: cleanup,
        get terminated() {
          return terminated;
        },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  if (!options.device.serial || options.device.state !== "booted")
    throw new DeviceError(
      "not_booted",
      "Android device is not booted",
      "Boot the emulator, or connect and unlock the device, and wait for adb to report device state.",
    );
  let why = "ACE_ANDROID_SCRCPY is off";
  if (options.env["ACE_ANDROID_SCRCPY"] !== "off") {
    // A missing server downloads in the device tools process, off the daemon's event loop.
    const jar =
      (await installedScrcpyJar({
        directory: options.platform.toolsDirectory,
        env: options.env,
      }).catch(() => undefined)) ??
      (await options.platform
        .downloadTools(options.runtime)
        .then((tools) => tools.scrcpy)
        .catch(() => undefined));
    checkAbort();
    why = "scrcpy-server couldn't be downloaded";
    if (jar) {
      try {
        const host = await options.platform
          .hostEncoding(options.device.serial)
          .catch(() => undefined);
        checkAbort();
        return await scrcpyCapture({ ...options, jar, ...(host ? { host } : {}) });
      } catch (error) {
        // scrcpy could not start on this image: agents still get stills from screenrecord.
        checkAbort();
        why = error instanceof Error ? error.message : "scrcpy-server didn't start";
      }
    }
  }
  return screenrecordCapture(
    { ...options, liveViewUnavailable: androidLiveViewError(why) },
    checkAbort,
  );
}
/** Why an Android capture without scrcpy refuses a live view, which is video only. */
function androidLiveViewError(why: string): DeviceError {
  return new DeviceError(
    "not_supported",
    `The Android live view needs scrcpy-server: ${why}`,
    "Use an Android 5 or later device or emulator image, check the network for the first download, unset ACE_ANDROID_SCRCPY, then start the live view again.",
  );
}
/**
 * The one Simulator window showing this device. A booted device whose window is closed (booted
 * from Xcode or the command line, say) gets it opened, then the window list is read again.
 */
async function simulatorWindow(
  screen: ScreenManager,
  options: {
    device: Device;
    platform: DevicePlatform;
    runtime: DeviceRuntime;
  },
  name: string,
  checkAbort: () => void,
) {
  for (let attempt = 0; ; attempt++) {
    const inventory = await screen.deviceTargets();
    checkAbort();
    const exact = inventory.windows.filter(
      (window) =>
        deviceWindowBundles.has(window.bundleId) &&
        (window.title === name ||
          [" –", " —", " -", " ("].some((suffix) => window.title.startsWith(`${name}${suffix}`))),
    );
    if (exact.length === 1 && exact[0]) return exact[0];
    if (exact.length > 1)
      throw new DeviceError(
        "busy",
        "More than one Simulator window shows this device's name",
        "Close the extra Simulator window, or rename one of the simulators, then start again.",
      );
    if (attempt === 0)
      // Newer Xcode has no Simulator app to open: the device window is then simply looked for.
      await options.platform.showSimulator(options.device).catch(() => undefined);
    else if (attempt >= 12)
      throw new DeviceError(
        "not_found",
        "The Simulator window for this device isn't open",
        `Download device tools in Devices for ace's serve-sim ${pinnedServeSim}, which shows the Simulator without a window. Or open the device's window in Simulator, make sure it isn't minimized, then start again.`,
      );
    await new Promise<void>((resolve) => options.runtime.after(500, resolve));
    checkAbort();
  }
}
