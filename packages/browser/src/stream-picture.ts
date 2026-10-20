import { AppDeviceId, ScreenId } from "@ace/protocol";
import { z } from "zod";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";

/*
 * The picture kinds' header: one picture of a simulator's or emulator's screen
 * (`streamKinds.deviceFrame`) or of a computer-use screen session (`streamKinds.screenFrame`),
 * a JPEG or one H.264 access unit, on the same envelope, ack window and keyframe rules as the
 * browser's video (ADR 0088, ADR 0064 "Shared media stream", ADR 0011 "One media pipeline").
 * The source id says what it shows: the device id, or the screen session id. Big-endian:
 *
 *   0  f64  sequence (per capture, `streamId`; acked cumulatively)
 *   8  f64  timestamp (ms)
 *   16 u16  width (the picture's pixels)
 *   18 u16  height
 *   20 f32  scale (picture pixels per device point: input maps through it)
 *   24 u16  rotation (degrees clockwise that show the picture upright: 0, 90, 180 or 270)
 *   26 u8   flags: bit 0 keyframe (every JPEG is one); bit 1 still (a one-shot screenshot,
 *           outside the live view's ack window: never acked)
 *   27 u8   codec length, then its ASCII (`jpeg`, or a WebCodecs H.264 string `avc1.PPCCLL`)
 *   ..  u16  source id length, then its UTF-8
 *   ..  u16  stream id length, then its UTF-8 (the capture; a new one starts over at a keyframe)
 *
 * The payload is the picture's own bytes: a JPEG, or an H.264 access unit in Annex B with its
 * parameter sets in front of every keyframe (no decoder description).
 */

export const pictureRotations = [0, 90, 180, 270] as const;
export type PictureRotation = (typeof pictureRotations)[number];

/** One picture as a viewer receives it. */
export interface PictureChunk {
  sequence: number;
  timestamp: number;
  width: number;
  height: number;
  scale: number;
  rotation: PictureRotation;
  /** `jpeg`, or the H.264 codec string the decoder is configured with. */
  codec: string;
  key: boolean;
  streamId: string;
  /** A one-shot screenshot, not part of the paced live stream: never acked. */
  still?: true;
  bytes: Uint8Array;
}

/** The two picture kinds: which one says what the source id names. */
export type PictureKind = typeof streamKinds.deviceFrame | typeof streamKinds.screenFrame;

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const PictureCodec = z.union([
  z.literal("jpeg"),
  z.string().regex(/^avc1\.[0-9a-fA-F]{6}$/),
]);

const Header = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  scale: z.number().finite().positive().max(64),
  rotation: z.union(pictureRotations.map((value) => z.literal(value))),
  codec: PictureCodec,
  streamId: ScreenId,
});

const sources = {
  [streamKinds.deviceFrame]: AppDeviceId,
  [streamKinds.screenFrame]: ScreenId,
} as const;

/** One picture's binary messages: its header and bytes, cut into socket-sized pieces. */
export function encodePicture(
  kind: PictureKind,
  id: number,
  sourceId: string,
  chunk: Omit<PictureChunk, "bytes">,
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
  view.setUint8(26, (chunk.key ? 1 : 0) | (chunk.still ? 2 : 0));
  view.setUint8(27, codec.length);
  let at = 28;
  meta.set(codec, at);
  at += codec.length;
  for (const part of [source, stream]) {
    view.setUint16(at, part.length);
    meta.set(part, at + 2);
    at += 2 + part.length;
  }
  return encodeStream(kind, id, meta, bytes);
}

/** A picture from its header and payload; throws on anything malformed. */
export function decodePicture(
  kind: PictureKind,
  meta: Uint8Array,
  payload: Uint8Array,
): { sourceId: string; frame: PictureChunk } {
  if (meta.length < 32) throw new StreamEnvelopeError("Short picture header");
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  let at = 28 + view.getUint8(27);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < 2; index++) {
    if (at + 2 > meta.length) throw new StreamEnvelopeError("Short picture header");
    const length = view.getUint16(at);
    if (at + 2 + length > meta.length) throw new StreamEnvelopeError("Short picture header");
    parts.push(meta.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  if (at !== meta.length) throw new StreamEnvelopeError("Picture header length mismatch");
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
  const sourceId = sources[kind].safeParse(text(source));
  if (!header.success || !sourceId.success || !payload.length)
    throw new StreamEnvelopeError("Invalid picture header");
  const rotation = header.data.rotation as PictureRotation;
  const flags = view.getUint8(26);
  return {
    sourceId: sourceId.data,
    frame: {
      ...header.data,
      rotation,
      // Every JPEG stands alone.
      key: header.data.codec === "jpeg" || (flags & 1) === 1,
      ...((flags & 2) === 2 ? { still: true as const } : {}),
      bytes: payload,
    },
  };
}
