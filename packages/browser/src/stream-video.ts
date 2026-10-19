import { BrowserVideoCodec, ThreadId } from "@ace/protocol";
import { z } from "zod";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";

/*
 * The browser video kind's header (`streamKinds.browserVideo`): one encoded chunk of a tab's
 * video (ADR 0088). Big-endian:
 *
 *   0  f64  sequence (per thread's live capture; acked cumulatively)
 *   8  f64  timestamp (ms)
 *   16 u32  width (CSS pixels: input coordinates map to these, as with JPEG frames)
 *   20 u32  height
 *   24 u16  coded width (the decoded picture's pixels)
 *   26 u16  coded height
 *   28 u8   flags: bit 0 keyframe
 *   29 u8   codec length, then its ASCII (a WebCodecs codec string)
 *   ..  u16  decoder description length (0: none; H.264's avcC on keyframes), then its bytes
 *   ..  u16  thread id length, then its UTF-8
 *   ..  u16  tab id length (0: none), then its UTF-8
 *
 * The payload is the chunk's own bytes.
 */

/** One encoded video chunk as a viewer receives it. */
export interface BrowserVideoChunk {
  sequence: number;
  timestamp: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  codec: string;
  key: boolean;
  /** The decoder description (H.264's avcC), on keyframes that need one. */
  description?: Uint8Array;
  tabId?: string;
  bytes: Uint8Array;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const Header = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().finite(),
  width: z.number().int().min(100).max(4096),
  height: z.number().int().min(100).max(4096),
  codedWidth: z.number().int().min(2).max(8192),
  codedHeight: z.number().int().min(2).max(8192),
  codec: BrowserVideoCodec,
  tabId: z.string().min(1).max(128).optional(),
});

/** One chunk's binary messages: its header and bytes, cut into socket-sized pieces. */
export function encodeBrowserVideo(
  id: number,
  threadId: string,
  chunk: Omit<BrowserVideoChunk, "bytes">,
  bytes: Uint8Array,
): Uint8Array[] {
  const codec = utf8(chunk.codec);
  const description = chunk.description ?? new Uint8Array(0);
  const thread = utf8(threadId);
  const tab = utf8(chunk.tabId ?? "");
  if (codec.length > 255) throw new StreamEnvelopeError("Codec too long");
  const meta = new Uint8Array(36 + codec.length + description.length + thread.length + tab.length);
  const view = new DataView(meta.buffer);
  view.setFloat64(0, chunk.sequence);
  view.setFloat64(8, chunk.timestamp);
  view.setUint32(16, chunk.width);
  view.setUint32(20, chunk.height);
  view.setUint16(24, chunk.codedWidth);
  view.setUint16(26, chunk.codedHeight);
  view.setUint8(28, chunk.key ? 1 : 0);
  view.setUint8(29, codec.length);
  let at = 30;
  meta.set(codec, at);
  at += codec.length;
  for (const part of [description, thread, tab]) {
    view.setUint16(at, part.length);
    meta.set(part, at + 2);
    at += 2 + part.length;
  }
  return encodeStream(streamKinds.browserVideo, id, meta, bytes);
}

/** A video chunk from its header and payload; throws on anything malformed. */
export function decodeBrowserVideo(
  meta: Uint8Array,
  payload: Uint8Array,
): { threadId: ThreadId; chunk: BrowserVideoChunk } {
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  if (meta.length < 36) throw new StreamEnvelopeError("Short video header");
  let at = 30 + view.getUint8(29);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < 3; index++) {
    if (at + 2 > meta.length) throw new StreamEnvelopeError("Short video header");
    const length = view.getUint16(at);
    if (at + 2 + length > meta.length) throw new StreamEnvelopeError("Short video header");
    parts.push(meta.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  if (at !== meta.length) throw new StreamEnvelopeError("Video header length mismatch");
  const [description, thread, tab] = parts as [Uint8Array, Uint8Array, Uint8Array];
  const tabId = text(tab);
  const header = Header.safeParse({
    sequence: view.getFloat64(0),
    timestamp: view.getFloat64(8),
    width: view.getUint32(16),
    height: view.getUint32(20),
    codedWidth: view.getUint16(24),
    codedHeight: view.getUint16(26),
    codec: text(meta.subarray(30, 30 + view.getUint8(29))),
    ...(tabId ? { tabId } : {}),
  });
  const threadId = ThreadId.safeParse(text(thread));
  if (!header.success || !threadId.success || !payload.length)
    throw new StreamEnvelopeError("Invalid video header");
  const { tabId: _tab, ...fields } = header.data;
  return {
    threadId: threadId.data,
    chunk: {
      ...fields,
      ...(tabId ? { tabId } : {}),
      key: (view.getUint8(28) & 1) === 1,
      ...(description.length ? { description: description.slice() } : {}),
      bytes: payload,
    },
  };
}
