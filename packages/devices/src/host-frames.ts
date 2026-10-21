import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { FrameDecoder } from "@ace/screen";
import type { EmulatorGrpc } from "./emulator-discovery.ts";
import { streamScreen, type ScreenStream } from "./emulator-grpc.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";
import type { VideoUnit } from "./scrcpy-video.ts";

/**
 * An Android emulator's screen encoded on the host (the Mac's hardware H.264 encoder) instead of
 * by the emulator's software encoder, which starves whenever the Mac is busy: measured on a
 * loaded M4 Max, 12–22 fps through scrcpy against 53–60 this way.
 *
 * The emulator writes each picture as RGBA into a shared file (gRPC `streamScreenshot`, MMAP);
 * the screen helper's `--encode-frames` mode, a process of its own, encodes the newest one and
 * writes the capture's own packets, read here into the same units scrcpy's stream gives. A new
 * size restarts only the screenshot stream; a new bit rate reaches the encoder in place.
 */
/** How long the first picture may take before the picture is left to scrcpy. */
const startupMs = 5000;

export interface HostFrames {
  /** The newest picture's size (0 × 0 until the first). */
  readonly size: { width: number; height: number };
  /** Pictures fit a `box` × `box` square: the long edge of the picture, either orientation. */
  resize(box: number): void;
  bitrate(bitrate: number): void;
  keyframe(): void;
  stop(): Promise<void>;
}

export async function startHostFrames(options: {
  grpc: EmulatorGrpc;
  /** The screen helper, whose `--encode-frames` mode encodes the pictures. */
  encoder: string;
  /** Where the shared picture file lives (ace's tools directory). */
  directory: string;
  /** The display's own size: no picture is larger. */
  display: { width: number; height: number };
  box: number;
  bitrate: number;
  runtime: Pick<DeviceRuntime, "spawn" | "id" | "after">;
  env: NodeJS.ProcessEnv;
  unit(unit: VideoUnit): void;
  failed(error: unknown): void;
}): Promise<HostFrames> {
  const file = join(options.directory, `emulator-frames-${options.runtime.id()}.rgba`);
  const handle = await open(file, "w", 0o600);
  try {
    await handle.truncate(options.display.width * options.display.height * 4);
  } finally {
    await handle.close();
  }
  let stopped = false;
  let size = { width: 0, height: 0 };
  let codec = "avc1.640033";
  /** Settled by the first picture, or the first failure: only a working stream is handed out. */
  const ready = Promise.withResolvers<void>();
  let started = false;
  const fail = (error: unknown) => {
    if (stopped) return;
    if (!started) return ready.reject(error);
    options.failed(error);
  };
  const encoder = options.runtime.spawn({
    command: options.encoder,
    args: ["--encode-frames", file],
    env: options.env,
    name: "emulator-encoder",
  });
  encoder.stderr.resume();
  const command = (value: object) => {
    if (!stopped && encoder.stdin.writable) encoder.stdin.write(`${JSON.stringify(value)}\n`);
  };
  encoder.stdin.on("error", () => {});
  const decoder = new FrameDecoder((frame) => {
    const header = frame.header;
    if (header.codec !== "h264" || stopped) return;
    if (header.videoCodec) codec = header.videoCodec;
    options.unit({
      payload: frame.payload,
      keyframe: header.keyframe === true,
      videoCodec: codec,
      width: header.width,
      height: header.height,
      pts: BigInt(Math.round(header.timestamp * 1000)),
    });
  });
  encoder.stdout.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  void encoder.exited.then(() =>
    fail(
      new DeviceError(
        "command_failed",
        "The emulator's encoder stopped",
        "Start the device view again.",
      ),
    ),
  );
  command({ op: "bitrate", bitrate: options.bitrate });

  let stream: ScreenStream | undefined;
  const watch = (box: number) => {
    stream?.close();
    const edge = Math.max(64, Math.round(box));
    stream = streamScreen({
      ...options.grpc,
      width: edge,
      height: edge,
      file,
      notice: (notice) => {
        // A display that is off sends an empty picture: nothing to encode.
        if (!notice.width || !notice.height) return;
        size = { width: notice.width, height: notice.height };
        if (!started) {
          started = true;
          ready.resolve();
        }
        command({
          op: "frame",
          seq: notice.seq,
          width: notice.width,
          height: notice.height,
          ts: notice.timestampUs / 1000,
        });
      },
      failed: fail,
    });
  };
  watch(options.box);
  const frames: HostFrames = {
    get size() {
      return size;
    },
    resize: (box) => {
      if (!stopped) watch(box);
    },
    bitrate: (bitrate) => command({ op: "bitrate", bitrate }),
    keyframe: () => command({ op: "keyframe" }),
    async stop() {
      if (stopped) return;
      stopped = true;
      stream?.close();
      encoder.stdin.end();
      await encoder.stop({ graceMs: 1000 }).catch(() => {});
      await rm(file, { force: true });
    },
  };
  // A display that never shows a picture, a refused token or a missing encoder: not this way.
  const cancel = options.runtime.after(startupMs, () =>
    fail(
      new DeviceError("timeout", "The emulator sent no picture", "Start the device view again."),
    ),
  );
  try {
    await ready.promise;
  } catch (error) {
    await frames.stop();
    throw error;
  } finally {
    cancel();
  }
  return frames;
}
