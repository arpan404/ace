import { videoCodecId, type VideoEvent } from "./scrcpy-protocol.ts";

export type VideoUnit = {
  /** Annex B access unit. A keyframe carries the stream's parameter sets in front of it. */
  payload: Buffer;
  keyframe: boolean;
  /** RFC 6381 codec string read from the stream's SPS. */
  videoCodec: string;
  width: number;
  height: number;
  /** Encoder timestamp in microseconds. */
  pts: bigint;
};

/** The `avc1.PPCCLL` codec string from the first SPS in an Annex B buffer. */
export function avcCodec(config: Buffer): string | undefined {
  for (let index = 0; index + 7 < config.length; index++) {
    if (config[index] !== 0 || config[index + 1] !== 0) continue;
    const start =
      config[index + 2] === 1
        ? index + 3
        : config[index + 2] === 0 && config[index + 3] === 1
          ? index + 4
          : -1;
    if (start < 0 || start + 3 >= config.length) continue;
    if (((config[start] ?? 0) & 31) === 7)
      return (
        "avc1." +
        config
          .subarray(start + 1, start + 4)
          .toString("hex")
          .toUpperCase()
      );
  }
  return undefined;
}

/**
 * Turns scrcpy video events into self-describing access units: the latest codec configuration is
 * kept and repeated in front of every keyframe, so a viewer can join at any IDR.
 */
export class ScrcpyVideoUnits {
  private config: Buffer | undefined;
  private codec = "avc1.42E01F";
  private width = 0;
  private height = 0;
  private readonly emit: (unit: VideoUnit) => void;
  private readonly resized: (width: number, height: number) => void;
  constructor(emit: (unit: VideoUnit) => void, resized: (width: number, height: number) => void) {
    this.emit = emit;
    this.resized = resized;
  }
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
  /** Parameter sets for a decoder that joins mid-stream. */
  get parameters(): Buffer | undefined {
    return this.config;
  }
  push(event: VideoEvent): void {
    if (event.type === "codec") {
      if (event.id !== videoCodecId.h264)
        throw new Error(`scrcpy sent an unsupported video codec 0x${event.id.toString(16)}`);
      return;
    }
    if (event.type === "session") {
      if (!event.width || !event.height || event.width > 16384 || event.height > 16384)
        throw new Error("scrcpy sent an invalid video size");
      this.width = event.width;
      this.height = event.height;
      // A new capture session (rotation, resize) starts with fresh parameter sets.
      this.config = undefined;
      this.resized(event.width, event.height);
      return;
    }
    if (event.config) {
      if (event.payload.length > 64 * 1024) throw new Error("scrcpy codec config exceeds limit");
      this.config = Buffer.from(event.payload);
      this.codec = avcCodec(this.config) ?? this.codec;
      return;
    }
    if (!this.width || !this.height) throw new Error("scrcpy sent video before its size");
    // A delta frame before the first keyframe of a session cannot be decoded by anyone.
    if (!this.config && !event.keyframe) return;
    this.emit({
      payload:
        event.keyframe && this.config ? Buffer.concat([this.config, event.payload]) : event.payload,
      keyframe: event.keyframe,
      videoCodec: this.codec,
      width: this.width,
      height: this.height,
      pts: event.pts,
    });
  }
}
