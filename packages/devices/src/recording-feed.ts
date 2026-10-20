import { framePacket, type Frame } from "@ace/screen";
import { H264Jpeg } from "./h264-jpeg.ts";
import type { DeviceRuntime } from "./runtime.ts";

/** The recording's image budget: what a capture streams for one while nobody watches. */
export const recordingImages = { maxWidth: 1280, maxHeight: 720, fps: 15 } as const;

/**
 * What a recording writes. While nobody watches, the capture streams JPEG at the recording's
 * budget and those frames go in as they come. While a live view keeps the capture on H.264, the
 * video is decoded here to JPEG at the same budget, so the view never changes for a recording.
 * Every frame is renumbered on one clock, so the file stays one ordered capture either way.
 */
export class RecordingFeed {
  private decoder: H264Jpeg | undefined;
  private sequence = 0;
  private timestamp = 0;
  /** The newest video frame's size and scale, for the scale of what it decodes to. */
  private video = { width: 1, scale: 1 };
  private stopped = false;
  private readonly options: {
    /** The capture's stream id, which every recorded frame carries. */
    streamId: string;
    /** ffmpeg, to decode video; without it a watched device records no frames. */
    ffmpeg: string | undefined;
    runtime: Pick<DeviceRuntime, "spawn" | "now">;
    env: NodeJS.ProcessEnv;
    write(frame: Frame): void;
    /** The decoder lost its place: ask the capture for a keyframe. */
    keyframe(): void;
    failure(error: unknown): void;
  };
  constructor(options: RecordingFeed["options"]) {
    this.options = options;
  }
  push(frame: Frame): void {
    if (this.stopped) return;
    if (frame.header.codec === "jpeg") {
      this.closeDecoder();
      this.write(frame.payload, frame.header, frame.header.timestamp);
      return;
    }
    const decoder = this.decoderFor();
    if (!decoder) return;
    this.video = { width: frame.header.width, scale: frame.header.scale ?? 1 };
    if (!decoder.push({ payload: frame.payload, keyframe: frame.header.keyframe === true }))
      this.options.keyframe();
  }
  stop(): void {
    this.stopped = true;
    this.closeDecoder();
  }
  private decoderFor(): H264Jpeg | undefined {
    if (this.decoder || !this.options.ffmpeg) return this.decoder;
    this.decoder = new H264Jpeg({
      ffmpeg: this.options.ffmpeg,
      fps: recordingImages.fps,
      box: recordingImages,
      runtime: this.options.runtime,
      env: this.options.env,
      image: (payload, width, height) =>
        this.write(
          payload,
          { width, height, scale: (this.video.scale * width) / this.video.width },
          this.options.runtime.now(),
        ),
      failure: (error) => {
        if (!this.stopped) this.options.failure(error);
      },
    });
    return this.decoder;
  }
  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = undefined;
    void decoder?.stop().catch(() => {});
  }
  private write(
    payload: Buffer,
    size: { width: number; height: number; scale?: number | undefined },
    at: number,
  ): void {
    if (this.stopped) return;
    this.timestamp = Math.max(this.timestamp, at);
    const header: Frame["header"] = {
      version: 1,
      sessionId: this.options.streamId,
      sequence: this.sequence++,
      timestamp: this.timestamp,
      width: size.width,
      height: size.height,
      ...(size.scale ? { scale: size.scale } : {}),
      codec: "jpeg",
      bytes: payload.length,
    };
    const packet = framePacket(header, payload);
    this.options.write({
      header,
      payload: packet.subarray(packet.length - payload.length),
      packet,
    });
  }
}
