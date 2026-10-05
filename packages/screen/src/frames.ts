import { ScreenFrameHeader, type ScreenLegacyFrameHeader } from "@ace/protocol";
import { LatestFrameHub, ScreenFrameReader } from "./frame-reader.ts";
export type Frame = {
  header: ScreenLegacyFrameHeader & {
    scale?: number | undefined;
    dirtyRects?: { x: number; y: number; w: number; h: number }[];
  };
  payload: Buffer;
  packet: Buffer;
};
export function framePacket(header: ScreenFrameHeader, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(ScreenFrameHeader.parse(header)));
  if (payload.length !== header.bytes || json.length > 4096) throw new Error("Invalid frame size");
  const packet = Buffer.allocUnsafe(4 + json.length + payload.length);
  packet.writeUInt32BE(json.length);
  json.copy(packet, 4);
  payload.copy(packet, 4 + json.length);
  return packet;
}
/** Node buffers are zero-copy views over the shared portable decoder's allocation. */
export class FrameDecoder {
  private readonly reader: ScreenFrameReader;
  constructor(emit: (frame: Frame) => void) {
    this.reader = new ScreenFrameReader(({ header: wire, payload, packet }) => {
      const header: Frame["header"] =
        wire.version === 1
          ? wire
          : {
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
      emit({
        header,
        payload: Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
        packet: Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength),
      });
    });
  }
  push(chunk: Buffer): void {
    this.reader.push(chunk);
  }
  end(): void {
    this.reader.end();
  }
}

export type FrameSink = (frame: Frame) => Promise<void>;
/** Shared bounded delivery policy, including portable browser/native consumers. */
export class FrameHub extends LatestFrameHub<Frame> {}
