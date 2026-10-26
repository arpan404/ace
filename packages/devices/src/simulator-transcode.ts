import { VideoChunkGate } from "@ace/browser/video-gate";
import { FrameDecoder, type Frame } from "@ace/screen";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";

/**
 * The least serve-sim sends while the screen is busy (its documented default is 6 to 30 Mbit/s
 * by screen size). Until a busier rate has been measured, a viewer is judged against this.
 */
export const simulatorSourceFloor = 6_000_000;
/** Below this share of the source's rate a viewer can't carry it: transcode for it. */
const transcodeBelow = 5 / 6;
/** And at or above this share, serve-sim's own stream passes through again (hysteresis). */
const passThroughFrom = 5.5 / 6;

/**
 * Whether a Simulator live view needs its picture re-encoded: its link can't carry serve-sim's
 * stream (`source`, the measured busy rate, never below the 6 Mbit/s floor), or its panel is
 * smaller than the Simulator's native picture (an iPad on a phone). `transcoding` is the current
 * state, so the rate has some room before it flips back.
 */
export function simulatorNeedsTranscode(input: {
  transcoding: boolean;
  bitrate: number;
  box: { maxWidth: number; maxHeight: number };
  native: { width: number; height: number } | undefined;
  /** serve-sim's busiest recent rate in bit/s, as measured; the floor when unknown. */
  source?: number | undefined;
}): boolean {
  const larger =
    input.native !== undefined &&
    (input.native.width > input.box.maxWidth || input.native.height > input.box.maxHeight);
  if (larger) return true;
  const source = Math.max(simulatorSourceFloor, input.source ?? 0);
  return input.bitrate < source * (input.transcoding ? passThroughFrom : transcodeBelow);
}

/**
 * How much input may wait in the transcoder's pipe. Past it, pictures are dropped rather than
 * queued: a few seconds of backlog would only make the live view late.
 */
export const simulatorTranscodeInputLimit = 2 * 1024 * 1024;

/**
 * serve-sim's H.264 re-encoded by the screen helper's `--transcode` mode (a process of its own,
 * hardware decode and encode) at the viewer's size and bit rate. Units go in as serve-sim sends
 * them; frame packets come out in the capture's framing.
 *
 * A transcoder that can't keep up gets fewer pictures, never broken ones: once a picture is
 * dropped, later deltas wait for serve-sim's next IDR (asked for through `needKeyframe`), since
 * they refer to the one dropped. Settings and keyframe requests are never dropped; while the
 * pipe is full the newest of each waits and goes ahead of the next picture.
 */
export interface SimulatorTranscode {
  push(payload: Buffer, keyframe: boolean, seq: number, ts: number): void;
  settings(settings: { bitrate: number; maxWidth: number; maxHeight: number }): void;
  keyframe(): void;
  stop(): Promise<void>;
}

const packet = (header: object, payload: Buffer = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify({ ...header, bytes: payload.length }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, payload]);
};

export function startSimulatorTranscode(options: {
  helper: string;
  runtime: Pick<DeviceRuntime, "spawn">;
  env: NodeJS.ProcessEnv;
  frame(frame: Frame): void;
  failed(error: unknown): void;
  /** A dropped picture broke the input's references: serve-sim's next IDR mends them. */
  needKeyframe(): void;
}): SimulatorTranscode {
  let stopped = false;
  const child = options.runtime.spawn({
    command: options.helper,
    args: ["--transcode"],
    env: options.env,
    name: "simulator-transcode",
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const decoder = new FrameDecoder((frame) => {
    if (!stopped && frame.header.codec === "h264") options.frame(frame);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      if (!stopped) options.failed(error);
    }
  });
  void child.exited.then(() => {
    if (!stopped)
      options.failed(
        new DeviceError(
          "command_failed",
          "The Simulator's transcoder stopped",
          "Start the device view again.",
        ),
      );
  });
  const room = () =>
    !stopped && child.stdin.writable && child.stdin.writableLength < simulatorTranscodeInputLimit;
  const gate = new VideoChunkGate();
  let owedSettings: Parameters<SimulatorTranscode["settings"]>[0] | undefined;
  let owedKeyframe = false;
  /** Settings and keyframe requests owed since the pipe filled, sent once it has room. */
  const sendControl = () => {
    if (!room()) return;
    if (owedSettings) child.stdin.write(packet({ op: "settings", ...owedSettings }));
    if (owedKeyframe) child.stdin.write(packet({ op: "keyframe" }));
    owedSettings = undefined;
    owedKeyframe = false;
  };
  child.stdin.on("drain", sendControl);
  return {
    push: (payload, keyframe, seq, ts) => {
      sendControl();
      const outcome = gate.offer("simulator", "input", keyframe, () => {
        if (!room()) return false;
        child.stdin.write(packet({ op: "frame", keyframe, seq, ts }, payload));
        return true;
      });
      if (outcome.keyframe && !stopped) options.needKeyframe();
    },
    settings: (settings) => {
      owedSettings = settings;
      sendControl();
    },
    keyframe: () => {
      owedKeyframe = true;
      sendControl();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      await child.stop({ graceMs: 1000 }).catch(() => {});
    },
  };
}
