import { framePacket, type Frame, type ScreenManager } from "@ace/screen";
import type { AppDevice as Device } from "@ace/protocol/devices";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import { findExecutable as discoverExecutable } from "@ace/provider-kit/discovery";
import { DeviceError } from "./sdk.ts";
import { JpegDecoder } from "./jpeg.ts";
import type { DevicePlatform } from "./platform.ts";
import type { Capture, DeviceRuntime } from "./runtime.ts";

export interface DeviceCapture extends Capture {
  screenSessionId?: string;
  streamId?: string;
}
export async function startCapture(options: {
  device: Device;
  streamId: string;
  fps: number;
  platform: DevicePlatform;
  screen?: ScreenManager;
  runtime: DeviceRuntime;
  env: NodeJS.ProcessEnv;
  publish(frame: Frame): void;
  failure(error: unknown): void;
}): Promise<DeviceCapture> {
  if (options.device.platform === "ios") {
    const screen = options.screen;
    if (!screen)
      throw new DeviceError(
        "tool_missing",
        "Screen helper is not configured",
        "Configure ACE_SCREEN_HELPER and grant Screen Recording and Accessibility permissions.",
      );
    screen.requireApproval("com.apple.iphonesimulator");
    const inventory = await screen.targets();
    const windows = inventory.windows.filter(
      (window) => window.bundleId === "com.apple.iphonesimulator",
    );
    const name = options.device.name;
    const exact = windows.filter(
      (window) =>
        window.title === name ||
        [" –", " —", " -", " ("].some((suffix) => window.title.startsWith(`${name}${suffix}`)),
    );
    const window = exact.length === 1 ? exact[0] : undefined;
    if (!window)
      throw new DeviceError(
        "not_found",
        "Simulator window is missing or ambiguous",
        "Open this Simulator and close other Simulator windows before starting capture.",
      );
    const state = await screen.start(
      { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      options.fps,
    );
    let stopped = false;
    let unwatch: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = async () => {
      stopped = true;
      try {
        unsubscribe?.();
      } finally {
        try {
          unwatch?.();
        } finally {
          await screen.stop(state.sessionId);
        }
      }
    };
    try {
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
        stop: cleanup,
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
  const { adb } = await options.platform.resolveAndroid();
  let dimensions = await options.platform.captureDimensions(options.device);
  const ffmpeg = await findExecutable("ffmpeg", options.env);
  const { runtime } = options;
  let stopped = false;
  let sequence = 0;
  type Cycle = {
    input: RawSupervisedProcess;
    output: RawSupervisedProcess;
    done: Promise<void>;
    intent: "run" | "restart" | "stop";
  };
  let cycle: Cycle | undefined;
  let restarting: Promise<void> | undefined;
  let restartCancel: (() => void) | undefined;
  const cancelRestart = () => {
    restartCancel?.();
    restartCancel = undefined;
  };
  const endCycle = async (current: Cycle | undefined, intent: "restart" | "stop") => {
    if (!current) return;
    current.intent = intent;
    await Promise.all([current.input.stop({ graceMs: 0 }), current.output.stop({ graceMs: 0 })]);
    await current.done;
  };
  const stop = async () => {
    stopped = true;
    cancelRestart();
    await endCycle(cycle, "stop");
    await restarting;
  };
  const run = async (): Promise<void> => {
    const input = runtime.spawn({
      command: adb,
      args: [
        "-s",
        options.device.serial ?? "",
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        "--time-limit",
        "180",
        "-",
      ],
      env: options.env,
      name: "device-h264",
    });
    let output: RawSupervisedProcess;
    try {
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
          "-vf",
          `fps=${options.fps},scale='min(3840,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease,mpdecimate=hi=0:lo=0:frac=0`,
          "-fps_mode",
          "vfr",
          "-c:v",
          "mjpeg",
          "-q:v",
          "5",
          "-f",
          "image2pipe",
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
          (width > height === dimensions.width > dimensions.height
            ? dimensions.width
            : dimensions.height),
      };
      const packet = framePacket(header, payload);
      options.publish({ header, payload: packet.subarray(packet.length - header.bytes), packet });
    });
    output.stdout.on("data", (chunk: unknown) => {
      if (stopped || current.intent !== "run") return;
      try {
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid JPEG chunk");
        jpeg.push(chunk);
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
  await run();
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
      dimensions = await options.platform.captureDimensions(options.device);
      if (!stopped) await run();
    })()
      .catch((error: unknown) => {
        if (!stopped) {
          stopped = true;
          options.failure(error);
        }
        throw error;
      })
      .finally(() => {
        restarting = undefined;
      });
    return restarting;
  };
  return { stop, restart };
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
