import { BrowserFrame, ThreadId } from "@ace/protocol";
import {
  encodeStream,
  streamKinds,
  StreamEnvelopeError,
  type StreamEnvelope,
} from "./stream-envelope.ts";
import { decodeBrowserVideo, type BrowserVideoChunk } from "./stream-video.ts";
import { decodeDownloadChunk, type DownloadChunkMessage } from "./stream-download.ts";
export { downloadBusy, encodeDownloadChunk, type DownloadChunkMessage } from "./stream-download.ts";

/*
 * The portable stream surface (`@ace/browser/stream`): the envelope, the browser frame kind's
 * header (below) and the video kind's (`stream-video.ts`). A frame's header carries what `BrowserFrame` carries besides its picture:
 *
 *   0  f64  sequence
 *   8  f64  timestamp
 *   16 u32  width (CSS pixels)
 *   20 u32  height
 *   24 u16  thread id length, then its UTF-8
 *   ..  u16  tab id length (0: none), then its UTF-8
 *
 * The payload is the JPEG's own bytes.
 */
export {
  isStreamPiece,
  StreamAssembler,
  StreamEnvelopeError,
  streamKinds,
  streamPieceBytes,
  type StreamEnvelope,
} from "./stream-envelope.ts";
export { encodeBrowserVideo, type BrowserVideoChunk } from "./stream-video.ts";

// Made per call (they are cheap): importing this module needs no text codecs.
const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** A frame as it arrives in binary: `BrowserFrame` with the JPEG's bytes instead of base64. */
export type BrowserFrameBytes = Omit<BrowserFrame, "data"> & { bytes: Uint8Array };
/** A decoded stream message: a JPEG frame, an encoded video chunk or a download chunk. */
export type StreamMessage =
  | { kind: "browser.frame"; threadId: ThreadId; frame: BrowserFrameBytes }
  | { kind: "browser.video"; threadId: ThreadId; chunk: BrowserVideoChunk }
  | DownloadChunkMessage;

const FrameHeader = BrowserFrame.omit({ data: true });

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

function decodeFrame(meta: Uint8Array, payload: Uint8Array): StreamMessage {
  if (meta.length < 28) throw new StreamEnvelopeError("Short frame header");
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  const threadLength = view.getUint16(24);
  if (28 + threadLength > meta.length) throw new StreamEnvelopeError("Short frame header");
  const tabLength = view.getUint16(26 + threadLength);
  if (28 + threadLength + tabLength !== meta.length)
    throw new StreamEnvelopeError("Frame header length mismatch");
  const tab = text(meta.subarray(28 + threadLength));
  const header = FrameHeader.safeParse({
    sequence: view.getFloat64(0),
    timestamp: view.getFloat64(8),
    width: view.getUint32(16),
    height: view.getUint32(20),
    ...(tab ? { tabId: tab } : {}),
  });
  const thread = ThreadId.safeParse(text(meta.subarray(26, 26 + threadLength)));
  if (!header.success || !thread.success || !payload.length)
    throw new StreamEnvelopeError("Invalid frame header");
  return {
    kind: "browser.frame",
    threadId: thread.data,
    frame: { ...header.data, bytes: payload },
  };
}

/** A stream message, decoded; undefined for a kind this build doesn't know (skipped). */
export function decodeStreamMessage(envelope: StreamEnvelope): StreamMessage | undefined {
  if (envelope.kind === streamKinds.browserFrame)
    return decodeFrame(envelope.meta, envelope.payload);
  if (envelope.kind === streamKinds.browserVideo)
    return { kind: "browser.video", ...decodeBrowserVideo(envelope.meta, envelope.payload) };
  if (envelope.kind === streamKinds.browserDownload)
    return decodeDownloadChunk(envelope.meta, envelope.payload);
  return undefined;
}
