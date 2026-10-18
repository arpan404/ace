// `@` mentions and uploads through the daemon's context service (`context.request`):
// mention.complete over the thread's checkout, and the resumable upload sequence (begin, chunks at
// the acknowledged offset, commit) that turns a file into an attachment the next message carries.
// Before a thread exists (New thread) the same operations run in a device-owned draft scope
// (`draft.create`), whose id the draft `ThreadRef` carries and `thread.create` adopts (ADR 0057).
import type { ClientApi } from "@ace/client";
import { ThreadId, WorkspaceId, type Attachment, type ContextOperation } from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";
import { ContextError, expect, uploadContextFile } from "@/lib/context-requests.ts";

export { ContextError } from "@/lib/context-requests.ts";

export interface ContextSource {
  /** Paths in the thread's checkout matching `query`, best first. */
  complete(thread: ThreadRef, query: string, signal: AbortSignal): Promise<readonly string[]>;
  onReleased(listener: (thread: ThreadRef, hash: string) => void): () => void;
  list(thread: ThreadRef, signal?: AbortSignal): Promise<readonly Attachment[]>;
  release(thread: ThreadRef, sha256: string): Promise<void>;
  /** Upload a file or image into the thread's context. `progress` is 0..1. */
  upload(thread: ThreadRef, file: File, progress: (fraction: number) => void): Promise<Attachment>;
}

export function daemonContextSource(client: ClientApi): ContextSource {
  const released = new Set<(thread: ThreadRef, hash: string) => void>();
  const ask = async (operation: ContextOperation, signal?: AbortSignal) =>
    (await client.request({ type: "context.request", operation }, signal ? { signal } : {})).result;
  return {
    onReleased(listener) {
      released.add(listener);
      return () => {
        released.delete(listener);
      };
    },
    async list(thread, signal) {
      const result = await ask(
        { op: "attachment.list", threadId: ThreadId.parse(thread.id) },
        signal,
      );
      return expect(result, "attachments").attachments;
    },
    async release(thread, hash) {
      expect(
        await ask(
          thread.draft
            ? { op: "draft.attachment.release", draftId: thread.id, sha256: hash }
            : { op: "attachment.release", threadId: ThreadId.parse(thread.id), sha256: hash },
        ),
        "ok",
      );
      for (const listener of released) listener(thread, hash);
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
        throw new ContextError("ace isn't ready for files yet. Try again in a moment.");
      return uploadContextFile(
        client,
        thread.draft ? { draftId: thread.id } : { threadId: thread.id },
        file,
        progress,
      );
    },
  };
}

/**
 * A draft scope for a thread that doesn't exist yet: mentions complete and files upload into it
 * before the first send, and `thread.create` adopts it through `context.draftId`. Released when
 * the project changes or the page closes, unless a thread adopted it.
 */
const retiredScopes = new WeakMap<ClientApi, Set<string>>();
export class ConsumedDraftScope extends Error {}
export function draftScopes(client: ClientApi) {
  const ask = async (operation: ContextOperation) =>
    (await client.request({ type: "context.request", operation })).result;
  return {
    retire(draftId: string): void {
      let retired = retiredScopes.get(client);
      if (!retired) {
        retired = new Set();
        retiredScopes.set(client, retired);
      }
      retired.add(draftId);
    },
    async resume(draftId: string): Promise<string> {
      // Local admission can precede daemon adoption, particularly while offline.
      if (retiredScopes.get(client)?.has(draftId))
        throw new ConsumedDraftScope("Draft already handed off");
      const reply = await ask({ op: "draft.mention.complete", draftId, query: "", limit: 1 });
      if (
        reply.kind === "error" &&
        reply.code === "forbidden" &&
        reply.message === "Draft already adopted"
      )
        throw new ConsumedDraftScope(reply.message);
      expect(reply, "completion");
      return draftId;
    },
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
