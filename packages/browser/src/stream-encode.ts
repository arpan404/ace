import type { BrowserFrame } from "@ace/protocol";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import type { PictureChunk, PictureKind } from "./stream-picture.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";

/*
 * Live stream messages as ace-media writes them (`media_wire` pieces): browser video and sound,
 * device and screen pictures, and the old JPEG frame kind. Only tests, benches and the fake
 * daemon build them in TypeScript, to feed clients' decoders. The daemon never encodes a live
 * envelope (X3): `bun run check:deps` forbids its packages from importing this module.
 */

const utf8 = (value: string) => new TextEncoder().encode(value);

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


/** One chunk's binary messages: its header and bytes. */
export function encodeBrowserAudio(
  id: number,
  threadId: string,
  chunk: Omit<BrowserAudioChunk, "bytes">,
  bytes: Uint8Array,
): Uint8Array[] {
  const codec = utf8(chunk.codec);
  const thread = utf8(threadId);
  const tab = utf8(chunk.tabId ?? "");
  if (codec.length > 255) throw new StreamEnvelopeError("Codec too long");
  const meta = new Uint8Array(26 + codec.length + thread.length + tab.length);
  const view = new DataView(meta.buffer);
  view.setFloat64(0, chunk.sequence);
  view.setFloat64(8, chunk.timestamp);
  view.setUint32(16, chunk.sampleRate);
  view.setUint8(20, chunk.channels);
  view.setUint8(21, codec.length);
  let at = 22;
  meta.set(codec, at);
  at += codec.length;
  for (const part of [thread, tab]) {
    view.setUint16(at, part.length);
    meta.set(part, at + 2);
    at += 2 + part.length;
  }
  return encodeStream(streamKinds.browserAudio, id, meta, bytes);
}


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


/** One frame's binary messages: its header and its JPEG, cut into socket-sized pieces. */
export function encodeBrowserFrame(
  id: number,
  threadId: string,
  frame: Omit<BrowserFrame, "data">,
  jpeg: Uint8Array,
): Uint8Array[] {
  const thread = utf8(threadId);
  const tab = utf8(frame.tabId ?? "");
  const meta = new Uint8Array(28 + thread.length + tab.length);
  const view = new DataView(meta.buffer);
  view.setFloat64(0, frame.sequence);
  view.setFloat64(8, frame.timestamp);
  view.setUint32(16, frame.width);
  view.setUint32(20, frame.height);
  view.setUint16(24, thread.length);
  meta.set(thread, 26);
  view.setUint16(26 + thread.length, tab.length);
  meta.set(tab, 28 + thread.length);
  return encodeStream(streamKinds.browserFrame, id, meta, jpeg);
}

