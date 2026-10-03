// `@` mentions and uploads through the daemon's context service (`context.request`):
// mention.complete over the thread's checkout, and the resumable upload sequence (begin, chunks at
// the acknowledged offset, commit) that turns a file into an attachment the next message carries.
import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  type Attachment,
  type ContextOperation,
  type ContextResult,
} from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export interface ContextSource {
  /** Paths in the thread's checkout matching `query`, best first. */
  complete(thread: ThreadRef, query: string, signal: AbortSignal): Promise<readonly string[]>;
  /** Upload a file or image into the thread's context. `progress` is 0..1. */
  upload(thread: ThreadRef, file: File, progress: (fraction: number) => void): Promise<Attachment>;
}

type Result = ContextResult["result"];

const messages: Partial<Record<Extract<Result, { kind: "error" }>["code"], string>> = {
  quota: "The daemon's upload space is full.",
  busy: "The daemon is busy with other uploads. Try again in a moment.",
  invalid_image: "That image can't be read.",
  forbidden: "This device may not add files to the thread.",
  not_found: "The thread is gone.",
};

/** Base64 of up to 48 KiB, which stays under the protocol's chunk size limit. */
const chunkBytes = 48 * 1024;

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

const is = <K extends Result["kind"]>(
  result: Result,
  kind: K,
): result is Extract<Result, { kind: K }> => result.kind === kind;

function expect<K extends Result["kind"]>(result: Result, kind: K): Extract<Result, { kind: K }> {
  if (result.kind === "error") throw new ContextError(messages[result.code] ?? result.message);
  if (!is(result, kind)) throw new ContextError("The daemon answered something unexpected.");
  return result;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function daemonContextSource(client: ClientApi): ContextSource {
  const ask = async (operation: ContextOperation, signal?: AbortSignal) =>
    (await client.request({ type: "context.request", operation }, signal ? { signal } : {})).result;
  return {
    async complete(thread, query, signal) {
      // TODO(client-gaps): feat/client-protocol-gaps adds a pre-thread draft scope; until then
      // the New thread composer has no checkout to complete against.
      if (thread.draft) return [];
      const result = await ask(
        { op: "mention.complete", threadId: ThreadId.parse(thread.id), query, limit: 8 },
        signal,
      );
      return expect(result, "completion").paths;
    },
    async upload(thread, file, progress) {
      if (thread.draft) throw new ContextError("Attach files once the thread has started.");
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength) throw new ContextError(`${file.name} is empty.`);
      const begun = expect(
        await ask({
          op: "upload.begin",
          threadId: ThreadId.parse(thread.id),
          sha256: await sha256(bytes),
          bytes: bytes.byteLength,
          name: file.name.slice(0, 255) || "file",
        }),
        "upload",
      );
      const view = new Uint8Array(bytes);
      let offset = begun.offset;
      while (offset < view.length) {
        const chunk = view.subarray(offset, offset + chunkBytes);
        const next = expect(
          await ask({
            op: "upload.chunk",
            uploadId: begun.uploadId,
            offset,
            data: base64(chunk),
          }),
          "upload",
        );
        if (next.offset <= offset) throw new ContextError("The upload stopped making progress.");
        offset = next.offset;
        progress(Math.min(0.99, offset / view.length));
      }
      const committed = expect(
        await ask({ op: "upload.commit", uploadId: begun.uploadId }),
        "attachment",
      );
      progress(1);
      return committed.attachment;
    },
  };
}
