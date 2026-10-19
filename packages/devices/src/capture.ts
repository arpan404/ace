import { simulatorCapture } from "./simulator-capture.ts";
import type { DeviceInput } from "@ace/protocol/devices";
import { type Frame, type ScreenManager, ScreenStopError } from "@ace/screen";
import type { ScreenStreamSettings, ScreenAgentScope } from "@ace/protocol";
import type { AppDevice as Device } from "@ace/protocol/devices";
import { findExecutable as discoverExecutable } from "@ace/provider-kit/discovery";
import { DeviceError } from "./sdk.ts";
import { screenrecordCapture } from "./android-screenrecord.ts";
import { scrcpyCapture } from "./scrcpy-capture.ts";
import { scrcpyServerJar } from "./scrcpy-jar.ts";
import type { DevicePlatform } from "./platform.ts";
import type { Capture, DeviceRuntime } from "./runtime.ts";
import { permissionDenied } from "./screen-failure.ts";

export interface DeviceCapture extends Capture {
  releaseInput?(): Promise<void>;
  input?(input: DeviceInput, guard: () => void): Promise<void>;
  screenSessionId?: string;
  streamId?: string;
  configure?(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }>;
  keyframe?(): Promise<void>;
  /** Pointer input may carry fingers other than the first. */
  readonly multiTouch?: boolean;
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
    const command = await discoverExecutable(
      options.env["ACE_SERVE_SIM"] ?? "serve-sim",
      options.env,
    );
    checkAbort();
    if (command) {
      const device = await options.platform.simulatorDevice(options.device);
      checkAbort();
      return simulatorCapture({ ...options, device, command });
    }
    if (options.env["ACE_SERVE_SIM"])
      throw new DeviceError(
        "tool_missing",
        "serve-sim was not found",
        "Install serve-sim on the device's Mac, or correct ACE_SERVE_SIM.",
      );
    const screen = options.screen;
    if (!screen)
      throw new DeviceError(
        "tool_missing",
        "Screen helper is not configured",
        "Configure ACE_SCREEN_HELPER and grant Screen Recording and Accessibility permissions.",
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
    const target = {
      kind: "window" as const,
      bundleId: window.bundleId,
      windowId: window.windowId,
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
        configure: (settings) => screen.configureStream(state.sessionId, settings),
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
      "Android emulator is not booted",
      "Boot the emulator and wait for adb to report device state.",
    );
  if (options.env["ACE_ANDROID_SCRCPY"] !== "off") {
    const jar = await scrcpyServerJar({
      directory: options.platform.toolsDirectory,
      env: options.env,
      fetch: options.runtime.fetch ?? fetch,
      id: options.runtime.id,
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch(() => undefined);
    checkAbort();
    if (jar) {
      try {
        return await scrcpyCapture({ ...options, jar });
      } catch {
        // scrcpy could not start on this image: the screenrecord view still works.
        checkAbort();
      }
    }
  }
  return screenrecordCapture(options, checkAbort);
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
        window.bundleId === "com.apple.iphonesimulator" &&
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
    if (attempt === 0) await options.platform.showSimulator(options.device);
    else if (attempt >= 12)
      throw new DeviceError(
        "not_found",
        "The Simulator window for this device isn't open",
        "Open it from Simulator's Window menu, make sure it isn't minimized, then start again.",
      );
    await new Promise<void>((resolve) => options.runtime.after(500, resolve));
    checkAbort();
  }
}
