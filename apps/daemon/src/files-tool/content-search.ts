import type { FilesSearchOptions, SearchQuery, Summary } from "@ace/files-native";
import type {
  FileOperation,
  FilesClientMessage,
  FilesServerMessage,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";
import { readCheckout, type ListingScope } from "./list-folder.ts";
import { SearchBatches } from "./search-batches.ts";
import { searchLines, searchQuery } from "./search-hits.ts";
import { aceFilesMissing, filesErrorCode } from "./tool.ts";
import type { WatchClock } from "./watch-fanout.ts";

type ClientFilesRequest = Extract<FilesClientMessage, { type: "files.request" }>;

/** What a content search needs from ace-files, so a test can stand in for the process. */
export type ContentSearcher = {
  search(path: string, query: SearchQuery, options: FilesSearchOptions): Promise<Summary>;
};

/** A `files.request` whose operation is a search, as both connection kinds carry it. */
export type SearchRequest = {
  requestId: string;
  threadId?: ThreadId | undefined;
  workspaceId?: WorkspaceId | undefined;
  scope?: "support" | undefined;
  operation: Extract<FileOperation, { op: "search" }>;
};

/** The search a `files.request` asks for, or undefined when it asks for something else. */
export function searchRequest(message: ClientFilesRequest): SearchRequest | undefined {
  const operation = message.operation;
  if (operation.op !== "search") return undefined;
  return { ...message, operation };
}

/** Searches one connection runs at once; a newer one for the same checkout replaces the older. */
export const searchesPerConnection = 4;
/** Batches wait while the connection has this much queued; a relay channel closes at 256 KiB. */
export const searchBacklogBytes = 128 * 1024;

export type ContentSearchOptions = {
  resolve: ListingScope;
  tool: ContentSearcher | undefined;
  clock: WatchClock;
  /** One message to the connection that asked. */
  push(message: FilesServerMessage): void;
  /** Bytes the connection has queued and not yet written. */
  buffered(): number;
  /** A reply may leave: the connection is open, may read, and may still read this thread. */
  replyAllowed(threadId: ThreadId | undefined): boolean;
  /** Track a task under the connection's budget; it reports its own failure. */
  run(task: Promise<void>): void;
};

export type ContentSearches = {
  start(message: SearchRequest): void;
  /** Cancel the search a `files.abort` names; false when no search has that id. */
  abort(requestId: string): boolean;
  /** The connection closed: every search stops. */
  close(): void;
};

/**
 * One connection's content searches (the local socket's or a relay channel's). Each runs on a
 * checkout the request may read, through the same binding a folder listing uses, and streams
 * its matches as `files.search.matches` batches before one `files.result` with the summary or
 * a `files.error`. A newer search of the same thread or project cancels the one before it.
 */
export function contentSearches(options: ContentSearchOptions): ContentSearches {
  const running = new Map<string, { controller: AbortController; key: string }>();
  const byScope = new Map<string, string>();
  let closed = false;
  const push = (message: FilesServerMessage) => {
    if (!closed) options.push(message);
  };
  const fail = (requestId: string, code: string, message: string) =>
    push({ type: "files.error", requestId, code, message });

  const search = async (message: SearchRequest, controller: AbortController) => {
    const { requestId, operation } = message;
    let batches: SearchBatches | undefined;
    try {
      const summary = await readCheckout(
        options.resolve,
        message,
        async (root, allowed): Promise<Summary> => {
          const tool = options.tool;
          if (!tool) throw aceFilesMissing();
          const queue = new SearchBatches({
            clock: options.clock,
            ready: () => options.buffered() < searchBacklogBytes,
            send: (files) => {
              if (allowed() && !controller.signal.aborted)
                push({ type: "files.search.matches", searchId: requestId, files });
              else controller.abort();
            },
          });
          batches = queue;
          controller.signal.addEventListener("abort", () => queue.cancel(), { once: true });
          const found = await tool.search(root, searchQuery(operation), {
            signal: controller.signal,
            onMatches: (file) => {
              // A grant lost mid-search stops it: nothing more is read or sent for it.
              if (!allowed()) controller.abort();
              else queue.add(file.path, searchLines(file));
            },
          });
          await queue.drain();
          return found;
        },
      );
      if (!options.replyAllowed(message.threadId)) {
        fail(requestId, "FORBIDDEN", "File access denied");
        return;
      }
      push({
        type: "files.result",
        requestId,
        value: { files: summary.files, matches: summary.matches, truncated: summary.limitHit },
      });
    } catch (error) {
      batches?.cancel();
      if (!options.replyAllowed(message.threadId)) {
        fail(requestId, "FORBIDDEN", "File access denied");
        return;
      }
      fail(
        requestId,
        filesErrorCode(error),
        error instanceof Error ? error.message : "The search failed",
      );
    }
  };

  return {
    start(message) {
      const requestId = message.requestId;
      if (closed) return;
      const key = message.threadId ?? message.workspaceId ?? "";
      const previous = byScope.get(key);
      if (previous !== undefined) running.get(previous)?.controller.abort();
      if (running.size >= searchesPerConnection && previous === undefined) {
        fail(requestId, "BUSY", "Searches are busy on this connection; try again");
        return;
      }
      const controller = new AbortController();
      running.set(requestId, { controller, key });
      byScope.set(key, requestId);
      options.run(
        search(message, controller).finally(() => {
          running.delete(requestId);
          if (byScope.get(key) === requestId) byScope.delete(key);
        }),
      );
    },
    abort(requestId) {
      const entry = running.get(requestId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },
    close() {
      closed = true;
      for (const entry of running.values()) entry.controller.abort();
    },
  };
}
