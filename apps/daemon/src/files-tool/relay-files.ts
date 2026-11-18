import type { ClientMessage, FilesServerMessage, ThreadId } from "@ace/protocol";
import type { FolderWatch, FolderWatchClient, FoldersChanged } from "./folder-watch.ts";
import { listFolderPage, type ListingScope } from "./list-folder.ts";
import { filesErrorCode, type FilesTool } from "./tool.ts";

/** At most this many folder listings run at once on one relay channel. */
export const relayListingLimit = 4;

export type RelayFilesOptions = {
  clientId: string;
  authorize(access: "read" | "operate"): boolean;
  /** The thread exists, is readable and is still live. */
  threadAccess(threadId: ThreadId): boolean;
  /** The thread's checkout is still the one the watch runs on. */
  matches(threadId: ThreadId, root: string): boolean;
  resolve: ListingScope;
  tool: FilesTool | undefined;
  folders: FolderWatch | undefined;
  /** One bounded control push on the channel. */
  push(message: FilesServerMessage): void;
  warn?(message: string, fields: object): void;
};

export type RelayFiles = {
  /** True when the message was a folder watch or a folder listing this channel owns. */
  accept(message: ClientMessage): boolean;
  /** Drop this channel's watches; queued work finishes on its own. */
  close(): void;
};

/**
 * Folder watches and folder listings on a relay channel. Neither waits in `accept`: a slow
 * checkout or a listing behind the four-listing cap must not hold the relay's channel, so each
 * runs as a tracked task and answers with `files.result` or `files.error` when it is done.
 */
export function relayFiles(options: RelayFilesOptions): RelayFiles {
  const tasks = new Set<Promise<void>>();
  let listings = 0;
  let closed = false;
  const run = (task: Promise<void>) => {
    const tracked = task
      .catch((error: unknown) =>
        options.warn?.("A relay file task failed", { error: String(error) }),
      )
      .finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };
  const push = (message: FilesServerMessage) => {
    if (!closed) options.push(message);
  };
  /** A reply may leave the channel only while it may still read what it asked for. */
  const replyAllowed = (threadId: ThreadId | undefined) =>
    !closed &&
    options.authorize("read") &&
    (threadId === undefined || options.threadAccess(threadId));
  const refuse = (requestId: string) =>
    push({
      type: "files.error",
      requestId,
      code: "FORBIDDEN",
      message: "File access denied",
    });
  const client: FolderWatchClient = {
    id: options.clientId,
    sendable: () => !closed && options.authorize("read"),
    valid: ({ id, root }) => options.threadAccess(id) && options.matches(id, root),
    send: (message: FoldersChanged) => {
      if (options.authorize("read") && options.threadAccess(message.threadId)) push(message);
    },
  };
  return {
    accept(message) {
      if (message.type === "files.watch") {
        if (!options.authorize("read") || !options.folders) return true;
        const threadId = message.threadId;
        const folders = message.folders;
        run(
          (async () => {
            const binding = await options.resolve(threadId, undefined, undefined, undefined);
            try {
              if (!binding.allowed("read") || binding.root === undefined) return;
              await options.folders?.watch(client, threadId, binding.root, folders);
            } finally {
              binding.release?.();
            }
          })(),
        );
        return true;
      }
      if (message.type === "files.request" && message.operation.op === "list.folder") {
        const requestId = message.requestId;
        if (listings >= relayListingLimit) {
          push({
            type: "files.error",
            requestId,
            code: "BUSY",
            message: "Folder listings are busy on this channel; try again",
          });
          return true;
        }
        listings++;
        const operation = message.operation;
        run(
          (async () => {
            try {
              const page = await listFolderPage(options.resolve, options.tool, {
                threadId: message.threadId,
                scope: message.scope,
                workspaceId: message.workspaceId,
                operation,
              });
              if (!replyAllowed(message.threadId)) {
                refuse(requestId);
                return;
              }
              push({ type: "files.result", requestId, value: page });
            } catch (error) {
              if (!replyAllowed(message.threadId)) {
                refuse(requestId);
                return;
              }
              push({
                type: "files.error",
                requestId,
                code: filesErrorCode(error),
                message: error instanceof Error ? error.message : "Folder listing failed",
              });
            } finally {
              listings--;
            }
          })(),
        );
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      if (options.folders) void options.folders.disconnect(options.clientId);
    },
  };
}
