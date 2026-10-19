import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";

/*
 * The browser audio kind's header (`streamKinds.browserAudio`): one encoded chunk of a tab's
 * sound (ADR 0088, Audio). Big-endian:
 *
 *   0  f64  sequence (per thread's live capture; never acked)
 *   8  f64  timestamp (ms, on the same clock as the video chunks' timestamps)
 *   16 u32  sample rate (Hz)
 *   20 u8   channels
 *   21 u8   codec length, then its ASCII (a WebCodecs codec string: `opus`)
 *   ..  u16  thread id length, then its UTF-8
 *   ..  u16  tab id length (0: none), then its UTF-8
 *
 * The payload is the chunk's own bytes (one Opus packet).
 */

/** One encoded audio chunk as a listener receives it. */
export interface BrowserAudioChunk {
  sequence: number;
  /** When the sound was captured, in the clock of the video chunks' `timestamp`. */
  timestamp: number;
  sampleRate: number;
  channels: number;
  codec: string;
  tabId?: string;
  bytes: Uint8Array;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const Header = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().finite(),
  sampleRate: z.number().int().min(8_000).max(192_000),
  channels: z.number().int().min(1).max(8),
  codec: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9.]+$/),
  tabId: z.string().min(1).max(128).optional(),
});

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

/** An audio chunk from its header and payload; throws on anything malformed. */
export function decodeBrowserAudio(
  meta: Uint8Array,
  payload: Uint8Array,
): { threadId: ThreadId; chunk: BrowserAudioChunk } {
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  if (meta.length < 26) throw new StreamEnvelopeError("Short audio header");
  let at = 22 + view.getUint8(21);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < 2; index++) {
    if (at + 2 > meta.length) throw new StreamEnvelopeError("Short audio header");
    const length = view.getUint16(at);
    if (at + 2 + length > meta.length) throw new StreamEnvelopeError("Short audio header");
    parts.push(meta.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  if (at !== meta.length) throw new StreamEnvelopeError("Audio header length mismatch");
  const [thread, tab] = parts as [Uint8Array, Uint8Array];
  const tabId = text(tab);
  const header = Header.safeParse({
    sequence: view.getFloat64(0),
    timestamp: view.getFloat64(8),
    sampleRate: view.getUint32(16),
    channels: view.getUint8(20),
    codec: text(meta.subarray(22, 22 + view.getUint8(21))),
    ...(tabId ? { tabId } : {}),
  });
  const threadId = ThreadId.safeParse(text(thread));
  if (!header.success || !threadId.success || !payload.length)
    throw new StreamEnvelopeError("Invalid audio header");
  const { tabId: _tab, ...fields } = header.data;
  return {
    threadId: threadId.data,
    chunk: { ...fields, ...(tabId ? { tabId } : {}), bytes: payload },
  };
}
