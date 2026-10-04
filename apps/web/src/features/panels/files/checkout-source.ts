import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { imageType, isCheckoutPath, isText } from "@ace/ui-core";

/*
 * A thread's checkout as the Files tool reads it: search through `context.request`
 * `mention.complete` (the daemon's path index), and file bytes through the files channel
 * (`files.request` stat, download and upload, ADR 0037 and 0058), scoped to the thread so the
 * daemon resolves its worktree. There is no directory listing on the wire yet, so nothing here
 * pretends to list a folder.
 */

/** The most the viewer reads to show a file; bigger files offer Download instead. */
export const viewLimit = 2 * 1024 * 1024;
/** The most one upload sends; the bytes are hashed in memory before they go. */
export const uploadLimit = 64 * 1024 * 1024;
/** The daemon's completion limit. */
const searchLimit = 50;

export type FileContent =
  | { kind: "text"; text: string; size: number; version: string }
  | { kind: "image"; blob: Blob; size: number; version: string }
  | { kind: "binary"; size: number; version: string }
  | { kind: "large"; size: number; version: string }
  | { kind: "missing" };

/** A failure said as a sentence, with the daemon's code kept for retry decisions. */
export class CheckoutError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}

const sentences: Record<string, string> = {
  NOT_FOUND: "This file isn't in the checkout any more.",
  FORBIDDEN: "This device may not read the thread's files.",
  OUTSIDE_WORKSPACE: "That path is outside the thread's checkout.",
  BUSY: "The thread's worktree is busy (being prepared or moved). Try again in a moment.",
  CONFLICT: "The file changed while it was being read. Try again.",
  QUOTA: "The daemon's file transfer limit was reached. Try again later.",
  UNSUPPORTED: "This daemon can't serve files for the thread.",
  offline: "The daemon is offline. Files load again once it reconnects.",
  timeout: "The daemon didn't answer in time.",
  forbidden: "This device may not search the thread's checkout.",
  not_found: "The thread's checkout wasn't found.",
  unsupported: "This daemon can't search the thread's checkout.",
};

/** A daemon error code as a `CheckoutError`. */
export function fromCode(code: string): CheckoutError {
  return new CheckoutError(code, sentences[code] ?? "The daemon couldn't read the checkout.");
}

/** Turn whatever a request threw into a `CheckoutError` a view can show. */
export function checkoutError(error: unknown): CheckoutError {
  if (error instanceof CheckoutError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new CheckoutError("aborted", "Stopped.");
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code === "daemon"
        ? error.message
        : error.code
      : "failed";
  return fromCode(code);
}

async function hash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += 65536) yield bytes.subarray(at, at + 65536);
}

export interface Stat {
  /** Null when nothing is at the path. */
  version: string | null;
  size: number | undefined;
  folder: boolean;
}

export interface CheckoutSource {
  /** Paths matching `query` (folders end in "/"), best first, at most 50. */
  search(threadId: string, query: string, signal?: AbortSignal): Promise<string[]>;
  stat(threadId: string, path: string, signal?: AbortSignal): Promise<Stat>;
  /** A file to show: text, an image, or why it can't be shown. */
  read(threadId: string, path: string, signal?: AbortSignal): Promise<FileContent>;
  /** Every byte of a file, for saving it on this device. */
  download(
    threadId: string,
    path: string,
    progress: (received: number) => void,
    signal?: AbortSignal,
  ): Promise<Blob>;
  /**
   * Put `file` at `path`. `expected` is the version it replaces (null: nothing is there); a
   * file that appeared or changed meanwhile fails with CONFLICT instead of being overwritten.
   */
  upload(
    threadId: string,
    path: string,
    file: Blob,
    expected: string | null,
    progress: (sent: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

const options = (signal?: AbortSignal) => (signal ? { signal } : {});
function guard(path: string): void {
  if (!isCheckoutPath(path)) throw fromCode("OUTSIDE_WORKSPACE");
}

export function daemonCheckout(client: ClientApi): CheckoutSource {
  const stat = async (threadId: string, path: string, signal?: AbortSignal): Promise<Stat> => {
    guard(path);
    const reply = await client
      .request(
        {
          type: "files.request",
          threadId: ThreadId.parse(threadId),
          operation: { op: "stat", path },
        },
        options(signal),
      )
      .catch((error: unknown) => {
        throw checkoutError(error);
      });
    if (reply.type === "files.error") throw fromCode(reply.code);
    if (reply.type !== "files.result") throw new CheckoutError("protocol", "Unexpected reply.");
    const value = reply.value;
    const record = typeof value === "object" && value !== null ? value : {};
    const version =
      "version" in record && typeof record.version === "string" ? record.version : null;
    const size = "size" in record && typeof record.size === "number" ? record.size : undefined;
    const type = "type" in record && typeof record.type === "string" ? record.type : "file";
    return { version, size, folder: type === "directory" };
  };
  const bytesOf = async function* (threadId: string, path: string, signal?: AbortSignal) {
    try {
      yield* client.downloadFile(
        { threadId: ThreadId.parse(threadId), op: "download", path, offset: 0 },
        options(signal),
      );
    } catch (error) {
      throw checkoutError(error);
    }
  };
  return {
    async search(threadId, query, signal) {
      const reply = await client
        .request(
          {
            type: "context.request",
            operation: {
              op: "mention.complete",
              threadId: ThreadId.parse(threadId),
              query: query.slice(0, 128),
              limit: searchLimit,
            },
          },
          options(signal),
        )
        .catch((error: unknown) => {
          throw checkoutError(error);
        });
      const result = reply.result;
      if (result.kind === "error") throw fromCode(result.code);
      if (result.kind !== "completion") throw new CheckoutError("protocol", "Unexpected reply.");
      return result.paths.filter(isCheckoutPath);
    },
    stat,
    async read(threadId, path, signal) {
      const info = await stat(threadId, path, signal);
      if (info.version === null) return { kind: "missing" };
      if (info.folder) throw new CheckoutError("folder", "That's a folder; pick a file inside it.");
      const version = info.version;
      if (info.size !== undefined && info.size > viewLimit)
        return { kind: "large", size: info.size, version };
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of bytesOf(threadId, path, signal)) {
        chunks.push(chunk);
        size += chunk.length;
        // The size grew past the limit since the stat: stop reading.
        if (size > viewLimit) return { kind: "large", size, version };
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const image = imageType(path);
      if (image) return { kind: "image", blob: new Blob([bytes], { type: image }), size, version };
      if (!isText(bytes)) return { kind: "binary", size, version };
      return { kind: "text", text: new TextDecoder().decode(bytes), size, version };
    },
    async download(threadId, path, progress, signal) {
      guard(path);
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;
      for await (const chunk of bytesOf(threadId, path, signal)) {
        parts.push(new Uint8Array(chunk));
        received += chunk.length;
        progress(received);
      }
      return new Blob(parts, { type: imageType(path) ?? "application/octet-stream" });
    },
    async upload(threadId, path, file, expected, progress, signal) {
      guard(path);
      if (file.size > uploadLimit)
        throw new CheckoutError("too_large", "Files over 64 MB can't be uploaded from here yet.");
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const sha256 = await hash(buffer);
      let sent = 0;
      const source = async function* () {
        for await (const chunk of chunksOf(bytes)) {
          yield chunk;
          sent += chunk.length;
          progress(sent);
        }
      };
      await client
        .uploadFile(
          { threadId: ThreadId.parse(threadId), path, expected, size: bytes.length, sha256 },
          source(),
          options(signal),
        )
        .catch((error: unknown) => {
          throw checkoutError(error);
        });
    },
  };
}
