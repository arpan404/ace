import { H264AccessUnits } from "./h264.ts";
import { framePacket, type Frame, type ScreenManager, ScreenStopError } from "@ace/screen";
import type { ScreenStreamSettings, ScreenAgentScope } from "@ace/protocol";
import type { AppDevice as Device } from "@ace/protocol/devices";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import { findExecutable as discoverExecutable } from "@ace/provider-kit/discovery";
import { DeviceError } from "./sdk.ts";
import { JpegDecoder } from "./jpeg.ts";
import type { DevicePlatform } from "./platform.ts";
import type { Capture, DeviceRuntime } from "./runtime.ts";
import { permissionDenied } from "./screen-failure.ts";

export interface DeviceCapture extends Capture {
  screenSessionId?: string;
  streamId?: string;
  configure?(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }>;
  keyframe?(): Promise<void>;
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
    const screen = options.screen;
    if (!screen)
      throw new DeviceError(
        "tool_missing",
        "Screen helper is not configured",
        "Configure ACE_SCREEN_HELPER and grant Screen Recording and Accessibility permissions.",
      );
    // Say plainly when macOS hasn't let the helper see the screen, before looking for windows.
    const permissions = await screen.currentPermissions();
    checkAbort();
    if (!permissions.screenRecording) throw permissionDenied("screenRecording");
    screen.requireApproval("com.apple.iphonesimulator", options.scope);
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
    const state = await screen.start(
      { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      options.fps,
      options.scope,
    );
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
  let transport = await options.platform.captureTransport(options.device);
  checkAbort();
  const serial = transport.serial;
  const ffmpeg = await findExecutable("ffmpeg", options.env);
  checkAbort();
  const { runtime } = options;
  let stopped = false;
  let sequence = 0;
  let settings: ScreenStreamSettings | undefined;
  let lastKeyframe = -Infinity;
  type Cycle = {
    input: RawSupervisedProcess;
    output: RawSupervisedProcess;
    done: Promise<void>;
    intent: "run" | "restart" | "stop";
  };
  let cycle: Cycle | undefined;
  let restarting: Promise<void> | undefined;
  let unwatch: (() => void) | undefined;
  let restartCancel: (() => void) | undefined;
  const cancelRestart = () => {
    restartCancel?.();
    restartCancel = undefined;
  };
  const endCycle = async (current: Cycle | undefined, intent: "restart" | "stop") => {
    if (!current) return;
    current.intent = intent;
    const results = await Promise.allSettled([
      current.input.stop({ graceMs: 0 }),
      current.output.stop({ graceMs: 0 }),
    ]);
    await current.done;
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Device capture cleanup failed");
  };
  const stop = async () => {
    stopped = true;
    cancelRestart();
    unwatch?.();
    options.signal?.removeEventListener("abort", abort);
    await endCycle(cycle, "stop");
    await restarting;
  };
  const run = async (): Promise<void> => {
    transport = await options.platform.captureTransport(options.device, serial);
    if (stopped) return;
    checkAbort();
    const factor = Math.min(
      1,
      (settings?.maxWidth ?? 3840) / transport.width,
      (settings?.maxHeight ?? 2160) / transport.height,
    );
    const size = {
      width: Math.max(2, Math.floor((transport.width * factor) / 2) * 2),
      height: Math.max(2, Math.floor((transport.height * factor) / 2) * 2),
    };
    const input = runtime.spawn({
      command: transport.adb,
      args: [
        "-s",
        transport.serial,
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        ...(settings
          ? ["--size", `${size.width}x${size.height}`, "--bit-rate", String(settings.bitrate)]
          : []),
        "--time-limit",
        "180",
        "-",
      ],
      env: options.env,
      name: "device-h264",
    });
    let output: RawSupervisedProcess;
    try {
      checkAbort();
      output = runtime.spawn({
        command: ffmpeg,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-f",
          "h264",
          "-i",
          "pipe:0",
          ...(settings?.codec === "h264"
            ? ["-c:v", "copy", "-bsf:v", "h264_metadata=aud=insert", "-f", "h264"]
            : [
                "-vf",
                `fps=${settings?.fps ?? options.fps},scale='min(${settings?.maxWidth ?? 3840},iw)':'min(${settings?.maxHeight ?? 2160},ih)':force_original_aspect_ratio=decrease,mpdecimate=hi=0:lo=0:frac=0`,
                "-fps_mode",
                "vfr",
                "-c:v",
                "mjpeg",
                "-q:v",
                "5",
                "-f",
                "image2pipe",
              ]),
          "pipe:1",
        ],
        env: options.env,
        name: "device-jpeg",
      });
    } catch (error) {
      await input.stop({ graceMs: 0 });
      throw error;
    }
    const current: Cycle = { input, output, intent: "run", done: Promise.resolve() };
    cycle = current;
    const jpeg = new JpegDecoder((payload, width, height) => {
      if (stopped || current.intent !== "run" || cycle !== current) return;
      const header = {
        version: 1 as const,
        sessionId: options.streamId,
        sequence: sequence++,
        timestamp: runtime.now(),
        width,
        height,
        codec: "jpeg" as const,
        bytes: payload.length,
        scale:
          width /
          (width > height === transport.width > transport.height
            ? transport.width
            : transport.height),
      };
      const packet = framePacket(header, payload);
      options.publish({ header, payload: packet.subarray(packet.length - header.bytes), packet });
    });
    const video = new H264AccessUnits((payload, keyframe, videoCodec) => {
      if (stopped || current.intent !== "run" || cycle !== current) return;
      const header = {
        version: 1 as const,
        sessionId: options.streamId,
        sequence: sequence++,
        timestamp: runtime.now(),
        width: size.width,
        height: size.height,
        scale: size.width / transport.width,
        codec: "h264" as const,
        keyframe,
        ...(keyframe ? { videoCodec } : {}),
        bytes: payload.length,
      };
      const packet = framePacket(header, payload);
      options.publish({ header, payload: packet.subarray(packet.length - payload.length), packet });
    });
    output.stdout.on("data", (chunk: unknown) => {
      if (stopped || current.intent !== "run") return;
      try {
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid JPEG chunk");
        if (settings?.codec === "h264") video.push(chunk);
        else jpeg.push(chunk);
      } catch (error) {
        fail(error);
      }
    });
    input.stdout.pipe(output.stdin);
    input.stderr.resume();
    output.stderr.resume();
    output.stdin.on("error", () => {
      void input.stop({ graceMs: 0 });
    });
    const earlyDecoder = output.exited.then((exit) => {
      if (!stopped && current.intent === "run" && !input.signal.aborted) {
        throw new DeviceError(
          "command_failed",
          `JPEG decoder exited: ${exit.reason}`,
          "Verify ffmpeg supports H.264 decoding and the mjpeg encoder.",
        );
      }
    });
    function fail(error: unknown) {
      if (stopped || current.intent !== "run" || cycle !== current) return;
      stopped = true;
      current.intent = "stop";
      cancelRestart();
      unwatch?.();
      options.signal?.removeEventListener("abort", abort);
      options.failure(error);
      void Promise.all([input.stop({ graceMs: 0 }), output.stop({ graceMs: 0 })]);
    }
    current.done = (async () => {
      try {
        const [exit, decoded] = await Promise.all([input.exited, output.exited, earlyDecoder]);
        if (stopped || current.intent !== "run") return;
        if (exit.code !== 0)
          throw new DeviceError(
            "command_failed",
            "Android screenrecord failed",
            "Use an emulator image supporting screenrecord H.264 output and install ffmpeg.",
          );
        if (decoded.code !== 0)
          throw new DeviceError(
            "command_failed",
            "Android JPEG decoder failed",
            "Verify ffmpeg supports H.264 decoding and the mjpeg encoder.",
          );
        // Android screenrecord has a finite native lifetime. Restart at the boundary.
        restartCancel = runtime.after(0, () => {
          restartCancel = undefined;
          if (!stopped && current.intent === "run" && cycle === current && !restarting)
            void run().catch(fail);
        });
      } catch (error) {
        fail(error);
        await Promise.all([input.stop({ graceMs: 0 }), output.stop({ graceMs: 0 })]);
      }
    })();
  };
  function abort() {
    void stop().catch(options.failure);
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await run();
    checkAbort();
    unwatch = options.platform.watchCaptureTransport(options.device, serial, (error) => {
      if (stopped) return;
      options.failure(error);
      void stop().catch(options.failure);
    });
    if (stopped) unwatch();
  } catch (error) {
    await stop();
    throw error;
  }
  const restart = (): Promise<void> => {
    if (stopped)
      return Promise.reject(
        new DeviceError("busy", "Device capture has stopped", "Start the device stream again."),
      );
    if (restarting) return restarting;
    cancelRestart();
    restarting = (async () => {
      await endCycle(cycle, "restart");
      if (stopped) return;
      if (!stopped) await run();
    })()
      .catch((error: unknown) => {
        if (!stopped) {
          stopped = true;
          unwatch?.();
          options.signal?.removeEventListener("abort", abort);
          cancelRestart();
          options.failure(error);
        }
        throw error;
      })
      .finally(() => {
        restarting = undefined;
      });
    return restarting;
  };
  return {
    stop,
    restart,
    async configure(next) {
      settings = next;
      await restart();
      return { codec: next.codec };
    },
    async keyframe() {
      if (runtime.now() - lastKeyframe < 1000) return;
      lastKeyframe = runtime.now();
      await restart();
    },
  };
}
/**
 * The one Simulator window showing this device. A booted device whose window is closed (booted
 * from Xcode or the command line, say) gets it opened, then the window list is read again.
 */
async function simulatorWindow(
  screen: ScreenManager,
  options: { device: Device; platform: DevicePlatform; runtime: DeviceRuntime },
  name: string,
  checkAbort: () => void,
) {
  for (let attempt = 0; ; attempt++) {
    const inventory = await screen.targets();
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
export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const path = await discoverExecutable(name, env);
  if (path) return path;
  throw new DeviceError(
    "tool_missing",
    `${name} is missing`,
    `Install ${name} and add its executable directory to the daemon's PATH.`,
  );
}
