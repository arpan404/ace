import type { ServerMessage, ThreadId } from "@ace/protocol";
import type { FilesTool } from "./tool.ts";

/** Where quick open reads: a thread's checkout and ace-files' index over it. */
export type QuickOpenSource = {
  /** The thread's checkout, or undefined while it cannot be read; the caller then falls back. */
  root(threadId: ThreadId): Promise<string | undefined>;
  /**
   * The index's paths, or undefined while it is still building or cannot answer. An empty array
   * is an answer ("nothing matches"), not a reason to fall back.
   */
  ask(root: string, query: string, limit: number): Promise<string[] | undefined>;
};

/**
 * Quick open's paths from ace-files, or undefined to leave the existing daemon answer in place.
 * A thread that cannot be read, a checkout still being prepared, an index that is not ready and
 * any failure all fall back, so results never disappear while the Rust index warms up.
 */
export async function quickOpenPaths(
  source: QuickOpenSource,
  threadId: ThreadId,
  query: string,
  limit: number,
): Promise<string[] | undefined> {
  try {
    const root = await source.root(threadId);
    if (root === undefined) return undefined;
    return await source.ask(root, query, limit);
  } catch {
    return undefined;
  }
}

/** What quick open reads from the daemon's store: a live thread's ready checkout. */
export type QuickOpenStore = {
  getThread(threadId: ThreadId): { deletedAt?: number | undefined } | undefined;
  executionWorkspace(threadId: ThreadId): { ready: boolean; path: string };
};

/** Quick open over the daemon's own books and the running ace-files. */
export function daemonQuickOpen(store: QuickOpenStore, tool: FilesTool): QuickOpenSource {
  return {
    root(threadId) {
      const thread = store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) return Promise.resolve(undefined);
      const binding = store.executionWorkspace(threadId);
      return Promise.resolve(binding.ready ? binding.path : undefined);
    },
    ask: (root, query, limit) => tool.quickOpen(root, query, limit),
  };
}

/** Where a `mention.complete` reply comes from: the daemon's store and the running ace-files. */
export type QuickOpenRequest = {
  requestId: string;
  threadId: ThreadId;
  query: string;
  limit: number;
};

/**
 * The completion reply for a `mention.complete`, or undefined to let the daemon's existing path
 * index answer. The quick-open ranking is ace-files' (the Rust index), which is intended to match
 * VS Code's quick open and may order hits differently from the TypeScript index; the reply shape
 * and the 50-path limit are unchanged.
 */
export async function quickOpenResult(
  store: QuickOpenStore | undefined,
  tool: FilesTool | undefined,
  request: QuickOpenRequest,
): Promise<Extract<ServerMessage, { type: "context.result" }> | undefined> {
  if (!store || !tool) return undefined;
  const paths = await quickOpenPaths(
    daemonQuickOpen(store, tool),
    request.threadId,
    request.query,
    request.limit,
  );
  if (paths === undefined) return undefined;
  return {
    type: "context.result",
    requestId: request.requestId,
    result: { kind: "completion", paths },
  };
}
