import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import { JpegDecoder } from "./jpeg.ts";
import type { DeviceRuntime } from "./runtime.ts";
import type { VideoUnit } from "./scrcpy-video.ts";

/** Bytes queued for the decoder before frames are dropped back to the next keyframe. */
const backlogLimit = 4 * 1024 * 1024;

/**
 * Still images for viewers without a video decoder, screenshots and recordings: the device's
 * H.264 goes through ffmpeg once and comes out as independent JPEG frames. The live H.264 view
 * never uses this.
 */
export class ScrcpyJpeg {
  private readonly process: RawSupervisedProcess;
  private readonly decoder: JpegDecoder;
  private waitingForKeyframe = true;
  private stopped = false;
  constructor(options: {
    ffmpeg: string;
    fps: number;
    runtime: DeviceRuntime;
    env: NodeJS.ProcessEnv;
    image(payload: Buffer, width: number, height: number): void;
    failure(error: unknown): void;
  }) {
    this.decoder = new JpegDecoder((payload, width, height) => {
      if (!this.stopped) options.image(payload, width, height);
    });
    this.process = options.runtime.spawn({
      command: options.ffmpeg,
      args: [
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
        `fps=${Math.max(1, Math.floor(options.fps))},mpdecimate=hi=0:lo=0:frac=0`,
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
  push(unit: VideoUnit): boolean {
    if (this.stopped) return true;
    if (this.process.stdin.writableLength > backlogLimit) this.waitingForKeyframe = true;
    if (this.waitingForKeyframe && !unit.keyframe) return false;
    this.waitingForKeyframe = false;
    this.process.stdin.write(unit.payload);
    return true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.process.stop({ graceMs: 0 });
  }
}
