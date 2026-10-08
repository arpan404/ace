// `@` mentions and uploads through the daemon's context service (`context.request`):
// mention.complete over the thread's checkout, and the resumable upload sequence (begin, chunks at
// the acknowledged offset, commit) that turns a file into an attachment the next message carries.
// Before a thread exists (New thread) the same operations run in a device-owned draft scope
// (`draft.create`), whose id the draft `ThreadRef` carries and `thread.create` adopts (ADR 0057).
import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  WorkspaceId,
  type Attachment,
  type ContextOperation,
  type ContextResult,
} from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export interface ContextSource {
  /** Paths in the thread's checkout matching `query`, best first. */
  complete(thread: ThreadRef, query: string, signal: AbortSignal): Promise<readonly string[]>;
  list(thread: ThreadRef, signal?: AbortSignal): Promise<readonly Attachment[]>;
  release(thread: ThreadRef, sha256: string): Promise<void>;
  /** Upload a file or image into the thread's context. `progress` is 0..1. */
  upload(thread: ThreadRef, file: File, progress: (fraction: number) => void): Promise<Attachment>;
}

type Result = ContextResult["result"];

const messages: Partial<Record<Extract<Result, { kind: "error" }>["code"], string>> = {
  busy: "Other files are uploading. Try again in a moment.",
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
  if (!is(result, kind)) throw new ContextError("Couldn't read the response. Try again.");
  return result;
}

async function sha256(file: File): Promise<string> {
  const { sha256: createHash } = await import("@noble/hashes/sha2.js");
  const hash = createHash.create();
  for (let offset = 0; offset < file.size; offset += chunkBytes)
    hash.update(new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer()));
  return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
    async list(thread, signal) {
      return expect(
        await ask({ op: "attachment.list", threadId: ThreadId.parse(thread.id) }, signal),
        "attachments",
      ).attachments;
    },
    async release(thread, hash) {
      if (thread.draft) return;
      const result = await ask({
        op: "attachment.release",
        threadId: ThreadId.parse(thread.id),
        sha256: hash,
      });
      if (result.kind === "error")
        throw new ContextError(
          result.code === "busy"
            ? "A queued message still uses this file. Remove that message first."
            : "Couldn't remove the file. Reconnect and try again.",
        );
    },
    async complete(thread, query, signal) {
      // A draft whose scope the daemon hasn't granted yet has nothing to complete against.
      if (thread.draft && !thread.id) return [];
      const result = await ask(
        thread.draft
          ? { op: "draft.mention.complete", draftId: thread.id, query, limit: 8 }
          : { op: "mention.complete", threadId: ThreadId.parse(thread.id), query, limit: 8 },
        signal,
      );
      return expect(result, "completion").paths;
    },
    async upload(thread, file, progress) {
      if (thread.draft && !thread.id)
        throw new ContextError("This project isn't ready for files yet. Try again in a moment.");
      const target = {
        sha256: await sha256(file),
        bytes: file.size,
        mimeType: file.type || undefined,
        name: file.name.slice(0, 255) || "file",
      };
      const begun = expect(
        await ask(
          thread.draft
            ? { op: "draft.upload.begin", draftId: thread.id, ...target }
            : { op: "upload.begin", threadId: ThreadId.parse(thread.id), ...target },
        ),
        "upload",
      );
      let offset = begun.offset;
      while (offset < file.size) {
        const chunk = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
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
        progress(Math.min(0.99, offset / file.size));
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

/**
 * A draft scope for a thread that doesn't exist yet: mentions complete and files upload into it
 * before the first send, and `thread.create` adopts it through `context.draftId`. Released when
 * the project changes or the page closes, unless a thread adopted it.
 */
export function draftScopes(client: ClientApi) {
  const ask = async (operation: ContextOperation) =>
    (await client.request({ type: "context.request", operation })).result;
  return {
    async create(workspaceId: string): Promise<string> {
      return expect(
        await ask({ op: "draft.create", workspaceId: WorkspaceId.parse(workspaceId) }),
        "draft",
      ).draftId;
    },
    release(draftId: string): void {
      void ask({ op: "draft.release", draftId }).catch(() => {
        // The daemon drops abandoned drafts on its own; nothing to tell the person.
      });
    },
  };
}
