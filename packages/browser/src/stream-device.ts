import { AppDeviceId, ScreenId } from "@ace/protocol";
import { z } from "zod";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";

/*
 * The device frame kind's header (`streamKinds.deviceFrame`): one picture of a simulator's or
 * emulator's screen, a JPEG or one H.264 access unit, on the same envelope, ack window and
 * keyframe rules as the browser's video (ADR 0088, ADR 0064 "Shared media stream"). The source
 * id says which device it shows. Big-endian:
 *
 *   0  f64  sequence (per capture, `streamId`; acked cumulatively)
 *   8  f64  timestamp (ms)
 *   16 u16  width (the picture's pixels)
 *   18 u16  height
 *   20 f32  scale (picture pixels per device point: input maps through it)
 *   24 u16  rotation (degrees clockwise that show the picture upright: 0, 90, 180 or 270)
 *   26 u8   flags: bit 0 keyframe (every JPEG is one)
 *   27 u8   codec length, then its ASCII (`jpeg`, or a WebCodecs H.264 string `avc1.PPCCLL`)
 *   ..  u16  source id length, then its UTF-8 (the device id)
 *   ..  u16  stream id length, then its UTF-8 (the capture; a new one starts over at a keyframe)
 *
 * The payload is the picture's own bytes: a JPEG, or an H.264 access unit in Annex B with its
 * parameter sets in front of every keyframe (no decoder description).
 */

export const deviceRotations = [0, 90, 180, 270] as const;
export type DeviceRotation = (typeof deviceRotations)[number];

/** One device picture as a viewer receives it. */
export interface DeviceFrameChunk {
  sequence: number;
  timestamp: number;
  width: number;
  height: number;
  scale: number;
  rotation: DeviceRotation;
  /** `jpeg`, or the H.264 codec string the decoder is configured with. */
  codec: string;
  key: boolean;
  streamId: string;
  bytes: Uint8Array;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const DeviceFrameCodec = z.union([
  z.literal("jpeg"),
  z.string().regex(/^avc1\.[0-9a-fA-F]{6}$/),
]);

const Header = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  scale: z.number().finite().positive().max(64),
  rotation: z.union(deviceRotations.map((value) => z.literal(value))),
  codec: DeviceFrameCodec,
  streamId: ScreenId,
});

/** One picture's binary messages: its header and bytes, cut into socket-sized pieces. */
export function encodeDeviceFrame(
  id: number,
  sourceId: string,
  chunk: Omit<DeviceFrameChunk, "bytes">,
  bytes: Uint8Array,
): Uint8Array[] {
  const codec = utf8(chunk.codec);
  const source = utf8(sourceId);
  const stream = utf8(chunk.streamId);
  if (codec.length > 255) throw new StreamEnvelopeError("Codec too long");
  const meta = new Uint8Array(32 + codec.length + source.length + stream.length);
  const view = new DataView(meta.buffer);
  view.setFloat64(0, chunk.sequence);
  view.setFloat64(8, chunk.timestamp);
  view.setUint16(16, chunk.width);
  view.setUint16(18, chunk.height);
  view.setFloat32(20, chunk.scale);
  view.setUint16(24, chunk.rotation);
  view.setUint8(26, chunk.key ? 1 : 0);
  view.setUint8(27, codec.length);
  let at = 28;
  meta.set(codec, at);
  at += codec.length;
  for (const part of [source, stream]) {
    view.setUint16(at, part.length);
    meta.set(part, at + 2);
    at += 2 + part.length;
  }
  return encodeStream(streamKinds.deviceFrame, id, meta, bytes);
}

/** A device picture from its header and payload; throws on anything malformed. */
export function decodeDeviceFrame(
  meta: Uint8Array,
  payload: Uint8Array,
): { sourceId: string; frame: DeviceFrameChunk } {
  if (meta.length < 32) throw new StreamEnvelopeError("Short device frame header");
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  let at = 28 + view.getUint8(27);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < 2; index++) {
    if (at + 2 > meta.length) throw new StreamEnvelopeError("Short device frame header");
    const length = view.getUint16(at);
    if (at + 2 + length > meta.length) throw new StreamEnvelopeError("Short device frame header");
    parts.push(meta.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  if (at !== meta.length) throw new StreamEnvelopeError("Device frame header length mismatch");
  const [source, stream] = parts as [Uint8Array, Uint8Array];
  const header = Header.safeParse({
    sequence: view.getFloat64(0),
    timestamp: view.getFloat64(8),
    width: view.getUint16(16),
    height: view.getUint16(18),
    // f32 loses digits a JSON scale kept; six significant digits is far below a point.
    scale: Number(view.getFloat32(20).toPrecision(6)),
    rotation: view.getUint16(24),
    codec: text(meta.subarray(28, 28 + view.getUint8(27))),
    streamId: text(stream),
  });
  const sourceId = AppDeviceId.safeParse(text(source));
  if (!header.success || !sourceId.success || !payload.length)
    throw new StreamEnvelopeError("Invalid device frame header");
  const rotation = header.data.rotation as DeviceRotation;
  return {
    sourceId: sourceId.data,
    frame: {
      ...header.data,
      rotation,
      // Every JPEG stands alone.
      key: header.data.codec === "jpeg" || (view.getUint8(26) & 1) === 1,
      bytes: payload,
    },
  };
}
