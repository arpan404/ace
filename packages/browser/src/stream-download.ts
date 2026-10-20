import { ThreadId } from "@ace/protocol";
import { encodeStream, streamKinds, StreamEnvelopeError } from "./stream-envelope.ts";

/*
 * The download chunk kind's header: which file a chunk of bytes belongs to and where.
 *
 *   0  f64  offset of the chunk in the file
 *   8  f64  the file's size
 *   16 u16  thread id length, then its UTF-8
 *   ..  u16  download id length, then its UTF-8
 *
 * The payload is the chunk's bytes (none for an empty file).
 */

/** The error of a download read the connection had no room for: the client reads it again. */
export const downloadBusy = "Busy: read the download again";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** A chunk of a finished download, fetched to the person's device. */
export interface DownloadChunkMessage {
  kind: "browser.download.chunk";
  threadId: ThreadId;
  downloadId: string;
  offset: number;
  size: number;
  bytes: Uint8Array;
}

export function encodeDownloadChunk(
  id: number,
  chunk: Omit<DownloadChunkMessage, "kind" | "threadId"> & { threadId: string },
): Uint8Array[] {
  const thread = utf8(chunk.threadId);
  const download = utf8(chunk.downloadId);
  const meta = new Uint8Array(20 + thread.length + download.length);
  const view = new DataView(meta.buffer);
  view.setFloat64(0, chunk.offset);
  view.setFloat64(8, chunk.size);
  view.setUint16(16, thread.length);
  meta.set(thread, 18);
  view.setUint16(18 + thread.length, download.length);
  meta.set(download, 20 + thread.length);
  return encodeStream(streamKinds.browserDownload, id, meta, chunk.bytes);
}

export function decodeDownloadChunk(meta: Uint8Array, payload: Uint8Array): DownloadChunkMessage {
  if (meta.length < 20) throw new StreamEnvelopeError("Short download header");
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  const threadLength = view.getUint16(16);
  if (20 + threadLength > meta.length) throw new StreamEnvelopeError("Short download header");
  const downloadLength = view.getUint16(18 + threadLength);
  if (20 + threadLength + downloadLength !== meta.length)
    throw new StreamEnvelopeError("Download header length mismatch");
  const offset = view.getFloat64(0);
  const size = view.getFloat64(8);
  const thread = ThreadId.safeParse(text(meta.subarray(18, 18 + threadLength)));
  const downloadId = text(meta.subarray(20 + threadLength));
  if (
    !thread.success ||
    !downloadId ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    offset + payload.length > size
  )
    throw new StreamEnvelopeError("Invalid download header");
  return {
    kind: "browser.download.chunk",
    threadId: thread.data,
    downloadId,
    offset,
    size,
    bytes: payload,
  };
}
