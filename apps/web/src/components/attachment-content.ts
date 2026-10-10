import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { artifactBlob } from "./artifact-loads.ts";
import type { FileSource } from "./attachment-format.ts";

/*
 * A file's bytes for its preview. A file not yet sent is the browser's own `File`, read in
 * place at any size. A sent one comes through the connection that owns its thread (local,
 * paired or relayed alike): never a URL built from a daemon address, and never a credential in
 * a URL an `<iframe>` could carry.
 */

/** How much of a text file the preview reads: one bounded daemon read. */
export const textPreviewBytes = 64 * 1024;

/** The largest sent file the preview loads whole: the client's own budget for originals. */
export const wholePreviewBytes = 32 * 1024 * 1024;

export interface TextPrefix {
  text: string;
  /** Bytes in the whole file. */
  total: number;
  /** The file goes on past what was read. */
  truncated: boolean;
}

/** A sent file over the budget can't be loaded whole on this device. */
export function tooLargeToLoad(
  source: FileSource,
): source is Extract<FileSource, { kind: "attachment" | "artifact" }> {
  return (
    source.kind !== "file" &&
    source.bytes > (source.kind === "artifact" ? 64 * 1024 * 1024 : wholePreviewBytes)
  );
}

function decode(bytes: Uint8Array, truncated: boolean): string {
  // Streaming leaves a character the cut split in two out, rather than drawing it broken.
  return new TextDecoder("utf-8").decode(bytes, { stream: truncated });
}

/** The first 64 KB of a file as text. */
export async function readTextPrefix(
  client: ClientApi,
  source: FileSource,
  signal: AbortSignal,
): Promise<TextPrefix> {
  if (source.kind === "file") {
    const truncated = source.file.size > textPreviewBytes;
    const bytes = new Uint8Array(await source.file.slice(0, textPreviewBytes).arrayBuffer());
    return { text: decode(bytes, truncated), total: source.file.size, truncated };
  }
  if (source.kind === "artifact") {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    for await (const chunk of client.downloadFile(
      {
        threadId: ThreadId.parse(source.threadId),
        op: "artifact.download",
        artifactId: source.artifactId,
        offset: 0,
      },
      { signal },
    )) {
      const available = Math.min(chunk.length, textPreviewBytes - total);
      chunks.push(chunk.slice(0, available));
      total += available;
      if (total === textPreviewBytes) break;
    }
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    const size = source.bytes || total;
    return { text: decode(bytes, size > total), total: size, truncated: size > total };
  }

  const reply = await client.request(
    {
      type: "context.request",
      operation: {
        op: "attachment.read",
        threadId: ThreadId.parse(source.threadId),
        sha256: source.sha256,
        variant: "original",
        offset: 0,
        limit: textPreviewBytes,
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
  return { text: decode(bytes, !result.eof), total: result.bytes, truncated: !result.eof };
}

/**
 * The whole file as a blob, typed `type` when given (a PDF frame needs its type even when the
 * browser didn't know it). A browser `File` is wrapped, not copied.
 */
export async function readWhole(
  client: ClientApi,
  source: FileSource,
  type: string | undefined,
  signal: AbortSignal,
): Promise<Blob> {
  if (source.kind === "file")
    return type && source.file.type !== type ? new Blob([source.file], { type }) : source.file;
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
