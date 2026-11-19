import type { ClientApi } from "@ace/client";
import { ItemId, ThreadId } from "@ace/protocol";
import { artifactBlob } from "./artifact-loads.ts";
import type { FileSource } from "./attachment-format.ts";

/*
 * A file's bytes for its preview. A file not yet sent is the browser's own `File`, read in
 * place at any size. A sent one comes through the connection that owns its thread (local,
 * paired or relayed alike): never a URL built from a daemon address, and never a credential in
 * a URL an `<iframe>` could carry.
 */

/** How much of a text file the preview dialog reads: one bounded daemon read. */
export const textPreviewBytes = 64 * 1024;

/** The largest unsent text file the preview opens for editing, read whole. */
export const editableTextBytes = 1024 * 1024;

/** The largest sent file the preview loads whole: the client's own budget for originals. */
export const wholePreviewBytes = 32 * 1024 * 1024;

/** The largest saved or linked file (a recording, a PDF) loaded whole. */
export const wholeFileBytes = 64 * 1024 * 1024;

/** The most one `attachment.read` returns. */
const attachmentReadBytes = 64 * 1024;

export interface TextPrefix {
  text: string;
  /** Bytes in the whole file; undefined when a cut stream didn't say. */
  total: number | undefined;
  /** The file goes on past what was read. */
  truncated: boolean;
}

/** A sent file over the budget can't be loaded whole on this device. */
export function tooLargeToLoad(
  source: FileSource,
): source is Extract<FileSource, { kind: "attachment" | "artifact" }> {
  // A linked file's size is only known once it is read: `readWhole` stops at the budget.
  if (source.kind === "file" || source.kind === "link") return false;
  return source.bytes > (source.kind === "artifact" ? wholeFileBytes : wholePreviewBytes);
}

/** The most `readWhole` loads of a source. */
export function wholeBudget(source: FileSource): number {
  return source.kind === "attachment" ? wholePreviewBytes : wholeFileBytes;
}

/** A linked file was longer than the budget it was read with. */
export class TooLargeToLoad extends Error {}

/** The bytes of a file an assistant message links to, as the daemon streams them. */
export function linkedFileChunks(
  client: ClientApi,
  source: Extract<FileSource, { kind: "link" }>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  return client.downloadFile(
    {
      threadId: ThreadId.parse(source.threadId),
      op: "link.download",
      itemId: ItemId.parse(source.itemId),
      reference: source.reference,
      offset: 0,
    },
    signal ? { signal } : {},
  );
}

interface Read {
  parts: Uint8Array<ArrayBuffer>[];
  total: number;
  /** The read stopped at `limit`, so the file may go on. */
  more: boolean;
}

/** Reads `chunks` up to `limit` bytes, stopping the stream as soon as it gets there. */
async function readUpTo(chunks: AsyncIterable<Uint8Array>, limit: number): Promise<Read> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    const taken = chunk.slice(0, limit - total);
    parts.push(taken);
    total += taken.length;
    if (total >= limit) return { parts, total, more: true };
  }
  return { parts, total, more: false };
}

function decode(bytes: Uint8Array, truncated: boolean): string {
  // Streaming leaves a character the cut split in two out, rather than drawing it broken.
  return new TextDecoder("utf-8").decode(bytes, { stream: truncated });
}

/** `size` is the whole file's, when known; otherwise a read that hit its limit may go on. */
async function prefixOf(read: Read, size: number | undefined): Promise<TextPrefix> {
  const bytes = new Uint8Array(await new Blob(read.parts).arrayBuffer());
  const total = size || (read.more ? undefined : read.total);
  const truncated = total === undefined ? read.more : total > read.total;
  return { text: decode(bytes, truncated), total, truncated };
}

function artifactChunks(
  client: ClientApi,
  source: Extract<FileSource, { kind: "artifact" }>,
  signal: AbortSignal,
) {
  return client.downloadFile(
    {
      threadId: ThreadId.parse(source.threadId),
      op: "artifact.download",
      artifactId: source.artifactId,
      offset: 0,
    },
    { signal },
  );
}

/** A sent attachment's original, `attachment.read` by `attachment.read` up to `limit`. */
async function attachmentPrefix(
  client: ClientApi,
  source: Extract<FileSource, { kind: "attachment" }>,
  limit: number,
  signal: AbortSignal,
): Promise<TextPrefix> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let total = source.bytes;
  let eof = false;
  while (!eof && offset < limit) {
    const reply = await client.request(
      {
        type: "context.request",
        operation: {
          op: "attachment.read",
          threadId: ThreadId.parse(source.threadId),
          sha256: source.sha256,
          variant: "original",
          offset,
          limit: Math.min(attachmentReadBytes, limit - offset),
        },
      },
      { signal },
    );
    const result = reply.result;
    if (result.kind !== "attachment.data")
      throw new Error(result.kind === "error" ? result.message : "Unexpected reply");
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    parts.push(bytes);
    offset += bytes.length;
    total = result.bytes;
    eof = result.eof || bytes.length === 0;
  }
  return prefixOf({ parts, total: offset, more: !eof }, total);
}

/** The first `limit` bytes of a file as text (64 KB unless asked for more). */
export async function readTextPrefix(
  client: ClientApi,
  source: FileSource,
  signal: AbortSignal,
  limit = textPreviewBytes,
): Promise<TextPrefix> {
  if (source.kind === "file") {
    const truncated = source.file.size > limit;
    const bytes = new Uint8Array(await source.file.slice(0, limit).arrayBuffer());
    return { text: decode(bytes, truncated), total: source.file.size, truncated };
  }
  if (source.kind === "link")
    return prefixOf(await readUpTo(linkedFileChunks(client, source, signal), limit), undefined);
  if (source.kind === "artifact")
    return prefixOf(await readUpTo(artifactChunks(client, source, signal), limit), source.bytes);
  return attachmentPrefix(client, source, limit, signal);
}

/**
 * The whole file as a blob, typed `type` when given (a PDF frame needs its type even when the
 * browser didn't know it). A browser `File` is wrapped, not copied. A linked file longer than
 * `wholeFileBytes` fails with `TooLargeToLoad`.
 */
export async function readWhole(
  client: ClientApi,
  source: FileSource,
  type: string | undefined,
  signal: AbortSignal,
): Promise<Blob> {
  if (source.kind === "file")
    return type && source.file.type !== type ? new Blob([source.file], { type }) : source.file;
  if (source.kind === "link") {
    // One byte past the budget tells a file over it from one exactly at it.
    const read = await readUpTo(linkedFileChunks(client, source, signal), wholeFileBytes + 1);
    if (read.more) throw new TooLargeToLoad("The file is over the preview budget");
    return new Blob(read.parts, { type: type ?? "application/octet-stream" });
  }
  if (source.kind === "artifact") {
    const blob = await artifactBlob(client, source, signal);
    return blob.slice(0, blob.size, type ?? "application/octet-stream");
  }

  const { bytes, mimeType } = await client.attachmentBytes(
    {
      threadId: source.threadId,
      sha256: source.sha256,
      variant: "original",
      // A draft restored after a reload doesn't know the size: the budget bounds it instead.
      maxBytes: Math.min(wholePreviewBytes, source.bytes || wholePreviewBytes),
    },
    { signal },
  );
  const owned =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
  return new Blob([owned], { type: type ?? mimeType });
}
