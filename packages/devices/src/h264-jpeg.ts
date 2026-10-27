import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import { JpegDecoder } from "./jpeg.ts";
import type { DeviceRuntime } from "./runtime.ts";

/** Bytes queued for the decoder before frames are dropped back to the next keyframe. */
const backlogLimit = 4 * 1024 * 1024;

/** One Annex B access unit; a keyframe carries its parameter sets in front. */
export type H264Unit = { payload: Buffer; keyframe: boolean };

/**
 * A device's H.264 through ffmpeg once, out as independent JPEG frames, for agents' stills and
 * recordings: scrcpy's capture while nobody watches, and a recording while a live view keeps the
 * capture on video. Live views never use this; they take the H.264 itself.
 */
export class H264Jpeg {
  private readonly process: RawSupervisedProcess;
  private readonly decoder: JpegDecoder;
  private waitingForKeyframe = true;
  private stopped = false;
  constructor(options: {
    ffmpeg: string;
    /**
     * The most pictures a second to make. Absent: one per access unit, for a source that already
     * keeps to its rate (scrcpy's device encoder); the rate filter always holds the newest back.
     */
    fps?: number | undefined;
    /** Fit the images inside this box, never upscaling; native size when absent. */
    box?: { maxWidth: number; maxHeight: number };
    runtime: Pick<DeviceRuntime, "spawn">;
    env: NodeJS.ProcessEnv;
    image(payload: Buffer, width: number, height: number): void;
    failure(error: unknown): void;
  }) {
    this.decoder = new JpegDecoder((payload, width, height) => {
      if (!this.stopped) options.image(payload, width, height);
    });
    this.process = options.runtime.spawn({
      command: options.ffmpeg,
      args: h264JpegArgs({ ...(options.fps ? { fps: options.fps } : {}), box: options.box }),
      env: options.env,
      name: "device-jpeg",
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try {
        this.decoder.push(chunk);
      } catch (error) {
        options.failure(error);
      }
    });
    this.process.stderr.resume();
    this.process.stdin.on("error", () => {});
    void this.process.exited.then((exit) => {
      if (!this.stopped) options.failure(new Error(`JPEG decoder exited: ${exit.reason}`));
    });
  }
  /**
   * Queues one access unit. Returns false when the decoder needs a keyframe before it can use
   * more: at the start, and after a backlog forced it to drop frames.
   */
  push(unit: H264Unit): boolean {
    if (this.stopped) return true;
    if (this.process.stdin.writableLength > backlogLimit) this.waitingForKeyframe = true;
    if (this.waitingForKeyframe && !unit.keyframe) return false;
    this.waitingForKeyframe = false;
    // The delimiter ends this unit for ffmpeg's parser, which otherwise holds it until the next
    // one arrives: on a still screen that is never, and the newest picture never comes out.
    this.process.stdin.write(Buffer.concat([withoutDelimiter(unit.payload), accessUnitDelimiter]));
    return true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.process.stop({ graceMs: 0 });
  }
}

/** An H.264 access unit delimiter (NAL type 9, any slice type). */
const accessUnitDelimiter = Buffer.from([0, 0, 0, 1, 9, 0xf0]);

/** The unit without a delimiter of its own in front: one already went after the last unit. */
function withoutDelimiter(payload: Buffer): Buffer {
  const start = payload[2] === 1 ? 3 : payload[3] === 1 ? 4 : 0;
  if (start && payload[0] === 0 && payload[1] === 0 && ((payload[start] ?? 0) & 0x1f) === 9)
    return payload.subarray(start + 2);
  return payload;
}

/**
 * ffmpeg's arguments to turn Annex B H.264 on stdin into JPEG images on stdout as soon as each
 * picture decodes: low-delay decoding and one encoder thread, so no picture waits inside it for
 * later ones. `fps` caps the images a second; `box` fits them inside it, never upscaling. Shared
 * with the screenrecord fallback, whose device side has no rate of its own.
 */
export function h264JpegArgs(options: {
  fps?: number;
  box?: { maxWidth: number; maxHeight: number } | undefined;
}): string[] {
  const { fps, box } = options;
  const filters = [
    ...(fps ? [`fps=${Math.max(1, Math.floor(fps))}`] : []),
    ...(box
      ? [
          `scale='min(${box.maxWidth},iw)':'min(${box.maxHeight},ih)':force_original_aspect_ratio=decrease`,
        ]
      : []),
    "mpdecimate=hi=0:lo=0:frac=0",
  ];
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-flags",
    "low_delay",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-vf",
    filters.join(","),
    "-threads",
    "1",
    "-fps_mode",
    "vfr",
    "-c:v",
    "mjpeg",
    "-q:v",
    "5",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}
