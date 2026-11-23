import type { StatementSync } from "node:sqlite";
import { ThreadId, ThreadTransitionView, type MachineCallOrigin, type Thread } from "@ace/protocol";

const maxWalkHops = 32;

/**
 * The `treeRootId` a newly created child inherits from its parent or starter.
 * Hidden host threads (Spade) are never a root: their direct children start their own tree.
 */
export function childTreeRoot(
  parent: Pick<Thread, "id" | "host" | "treeRootId"> | undefined,
): ThreadId | undefined {
  if (!parent || parent.host !== undefined) return undefined;
  return parent.treeRootId ?? parent.id;
}

/**
 * The tree root sent to a paired machine when delegating across hosts.
 * `null` tells the peer that the caller is a hidden host thread so the remote child starts its own tree.
 */
export function originTreeRoot(
  thread: Pick<Thread, "id" | "host" | "treeRootId"> | undefined,
  threadId: ThreadId,
): ThreadId | null {
  if (thread?.host !== undefined) return null;
  return thread?.treeRootId ?? threadId;
}

/**
 * The `treeRootId` recorded on a child delegated from a paired machine.
 * When the peer sent `null` (its caller is a hidden host thread), the child records itself so lazy
 * fallback never treats `delegatedFrom.threadId` as the root. Older peers that omit `rootThreadId`
 * fall back to `origin.threadId`.
 */
export function remoteChildTreeRoot(
  origin: Pick<MachineCallOrigin, "threadId" | "rootThreadId">,
  childId: ThreadId,
): ThreadId {
  if (origin.rootThreadId === null) return childId;
  return origin.rootThreadId ?? origin.threadId;
}

interface AncestorMeta {
  host?: string | undefined;
  treeRootId?: ThreadId | undefined;
  delegatedBy?: ThreadId | undefined;
  startedBy?: ThreadId | undefined;
  delegatedFrom?: { threadId: ThreadId; rootThreadId?: ThreadId | undefined } | undefined;
}

/**
 * Lazily resolves `treeRootId` for stored threads written before the field existed (ADR 0170).
 * Reads only indexed PK lookups (`delegated_threads.child_id`, `threads.id`) on cache miss, never
 * a startup or full-table pass.
 */
export class TreeRootResolver {
  private readonly statement: (sql: string) => StatementSync;
  private hasDelegatedTable = false;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  resolve(thread: Thread): Thread {
    if (thread.treeRootId !== undefined || thread.host !== undefined) return thread;
    if (thread.delegatedFrom !== undefined) {
      const root = thread.delegatedFrom.rootThreadId ?? thread.delegatedFrom.threadId;
      return root === thread.id ? thread : { ...thread, treeRootId: root };
    }
    const root = this.findRoot(thread);
    return root !== undefined && root !== thread.id ? { ...thread, treeRootId: root } : thread;
  }
  private findRoot(thread: Thread): ThreadId | undefined {
    const seen = new Set<string>([thread.id]);
    let currentId: ThreadId = thread.id;
    let hint: Pick<AncestorMeta, "delegatedBy" | "startedBy"> = {
      delegatedBy: thread.delegatedBy,
      startedBy: thread.startedBy,
    };
    for (let hop = 0; hop < maxWalkHops; hop++) {
      const edge = this.delegationEdge(currentId);
      let nextParent: ThreadId | undefined;
      if (edge) {
        if (edge.rootId !== currentId && !seen.has(edge.rootId)) {
          const rootMeta = this.readMeta(edge.rootId);
          if (!rootMeta) return edge.rootId;
          if (rootMeta.host === undefined) {
            if (rootMeta.treeRootId !== undefined) return rootMeta.treeRootId;
            if (rootMeta.delegatedFrom !== undefined)
              return rootMeta.delegatedFrom.rootThreadId ?? rootMeta.delegatedFrom.threadId;
            if (rootMeta.delegatedBy === undefined && rootMeta.startedBy === undefined)
              return edge.rootId;
            seen.add(edge.rootId);
            currentId = edge.rootId;
            hint = rootMeta;
            continue;
          }
          // Recorded root is a hidden host thread: stop directly below it.
          if (edge.parentId === edge.rootId) return currentId === thread.id ? undefined : currentId;
        }
        nextParent = edge.parentId;
      } else {
        nextParent = hint.delegatedBy ?? hint.startedBy;
      }
      if (!nextParent || seen.has(nextParent))
        return currentId === thread.id ? undefined : currentId;
      const parentMeta = this.readMeta(nextParent);
      if (!parentMeta) return nextParent;
      if (parentMeta.host !== undefined) return currentId === thread.id ? undefined : currentId;
      if (parentMeta.treeRootId !== undefined) return parentMeta.treeRootId;
      if (parentMeta.delegatedFrom !== undefined)
        return parentMeta.delegatedFrom.rootThreadId ?? parentMeta.delegatedFrom.threadId;
      seen.add(nextParent);
      currentId = nextParent;
      hint = parentMeta;
    }
    return currentId === thread.id ? undefined : currentId;
  }
  private delegationEdge(childId: ThreadId): { parentId: ThreadId; rootId: ThreadId } | undefined {
    if (!this.hasDelegatedTable) {
      const exists = this.statement(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delegated_threads'",
      ).get();
      if (!exists) return undefined;
      this.hasDelegatedTable = true;
    }
    const row = this.statement(
      "SELECT parent_id, root_id FROM delegated_threads WHERE child_id = ?",
    ).get(childId);
    if (!row || typeof row.parent_id !== "string" || typeof row.root_id !== "string")
      return undefined;
    const parentId = ThreadId.safeParse(row.parent_id);
    const rootId = ThreadId.safeParse(row.root_id);
    if (!parentId.success || !rootId.success) return undefined;
    return { parentId: parentId.data, rootId: rootId.data };
  }
  private readMeta(id: ThreadId): AncestorMeta | undefined {
    const row = this.statement(
      "SELECT json_extract(client, '$.host') AS host, transitions FROM threads WHERE id = ?",
    ).get(id);
    if (!row) return undefined;
    const host = typeof row.host === "string" ? row.host : undefined;
    if (row.transitions == null) return { host };
    let parsed: ReturnType<typeof ThreadTransitionView.safeParse>;
    try {
      parsed = ThreadTransitionView.safeParse(JSON.parse(String(row.transitions)));
    } catch {
      return { host };
    }
    if (!parsed.success) return { host };
    const { treeRootId, delegatedBy, startedBy, delegatedFrom } = parsed.data;
    return { host, treeRootId, delegatedBy, startedBy, delegatedFrom };
  }
}
