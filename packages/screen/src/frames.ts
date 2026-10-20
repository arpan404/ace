import { ScreenFrameHeader, type ScreenLegacyFrameHeader } from "@ace/protocol";
import { LatestFrameHub } from "./frame-hub.ts";

/*
 * Frames inside the daemon. A native screen helper writes each captured frame to its pipe as
 * `u32 header length | JSON ScreenFrameHeader | payload`, and a recording file is the same
 * frames back to back. Neither ever reaches a client: viewers get pictures on the shared media
 * stream (`@ace/browser/picture-channel`, ADR 0011 "One media pipeline").
 */

export type Frame = {
  header: ScreenLegacyFrameHeader & {
    scale?: number | undefined;
    dirtyRects?: { x: number; y: number; w: number; h: number }[];
    /** Degrees clockwise a viewer turns the picture to show it upright. */
    rotation?: 0 | 90 | 180 | 270;
  };
  payload: Buffer;
  /** The frame as the helper pipe and recording files carry it. */
  packet: Buffer;
};

const headerLimit = 4096;

/** One frame in the helper pipe's framing (fixtures, recordings). */
export function framePacket(header: ScreenFrameHeader, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(ScreenFrameHeader.parse(header)));
  if (payload.length !== header.bytes || json.length > headerLimit)
    throw new Error("Invalid frame size");
  const packet = Buffer.allocUnsafe(4 + json.length + payload.length);
  packet.writeUInt32BE(json.length);
  json.copy(packet, 4);
  payload.copy(packet, 4 + json.length);
  return packet;
}

/** The v2 header's short names, as the v1 header the daemon works with. */
function normalize(wire: ScreenFrameHeader): Frame["header"] {
  if (wire.version === 1) return wire;
  return {
    version: 1,
    sessionId: wire.sessionId,
    sequence: wire.seq,
    timestamp: wire.ts,
    width: wire.width,
    height: wire.height,
    codec: wire.codec,
    keyframe: wire.keyframe,
    videoCodec: wire.videoCodec,
    bytes: wire.bytes,
    scale: wire.scale,
    ...(wire.captureGeneration ? { captureGeneration: wire.captureGeneration } : {}),
    ...(wire.dirtyRects ? { dirtyRects: wire.dirtyRects } : {}),
  };
}

/**
 * Reads a helper pipe (or a recording) in chunks of any size. Each frame's packet is one
 * allocation; its payload is a view into it.
 */
export class FrameDecoder {
  private destination: Buffer = Buffer.alloc(4);
  private offset = 0;
  private phase: "length" | "header" | "payload" = "length";
  private header: ScreenFrameHeader | undefined;
  private packet: Buffer | undefined;
  private readonly emit: (frame: Frame) => void;
  private readonly text = new TextDecoder("utf-8", { fatal: true });
  constructor(emit: (frame: Frame) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      const count = Math.min(chunk.length - position, this.destination.length - this.offset);
      chunk.copy(this.destination, this.offset, position, position + count);
      this.offset += count;
      position += count;
      if (this.offset !== this.destination.length) continue;
      this.offset = 0;
      if (this.phase === "length") {
        const length = this.destination.readUInt32BE(0);
        if (length === 0 || length > headerLimit) throw new Error("Frame header exceeds limit");
        this.destination = Buffer.alloc(length);
        this.phase = "header";
      } else if (this.phase === "header") {
        const raw: unknown = JSON.parse(this.text.decode(this.destination));
        this.header = ScreenFrameHeader.parse(raw);
        const prefix = this.destination;
        this.packet = Buffer.allocUnsafe(4 + prefix.length + this.header.bytes);
        this.packet.writeUInt32BE(prefix.length);
        prefix.copy(this.packet, 4);
        this.destination = this.packet.subarray(4 + prefix.length);
        this.phase = "payload";
      } else {
        const header = this.header;
        const payload = this.destination;
        const packet = this.packet;
        if (!header || !packet) throw new Error("Missing frame header");
        this.reset();
        this.emit({ header: normalize(header), payload, packet });
      }
    }
  }
  end(): void {
    if (this.phase !== "length" || this.offset !== 0) throw new Error("Truncated frame");
  }
  private reset(): void {
    this.destination = Buffer.alloc(4);
    this.offset = 0;
    this.header = undefined;
    this.packet = undefined;
    this.phase = "length";
  }
}

export type FrameSink = (frame: Frame) => Promise<void>;
/** Bounded delivery inside the daemon: one frame in flight and the newest pending per sink. */
export class FrameHub extends LatestFrameHub<Frame> {}
