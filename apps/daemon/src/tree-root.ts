import type { MachineCallOrigin, Thread, ThreadId } from "@ace/protocol";

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

export interface DelegationEdgeReader {
  get(child: string): { parentId: ThreadId } | undefined;
}

export type TreeRootAncestor = Pick<
  Thread,
  "id" | "host" | "treeRootId" | "delegatedBy" | "startedBy" | "delegatedFrom"
>;

/**
 * Lazily resolves `treeRootId` for stored threads written before the field existed (ADR 0170).
 * Reads ancestors through the store's decoded thread lookup and the injected delegation journal,
 * never scanning history or re-validating stored columns.
 */
export class TreeRootResolver {
  private readonly readThread: (id: ThreadId) => TreeRootAncestor | undefined;
  private journal: DelegationEdgeReader | undefined;
  constructor(
    readThread: (id: ThreadId) => TreeRootAncestor | undefined,
    journal?: DelegationEdgeReader,
  ) {
    this.readThread = readThread;
    this.journal = journal;
  }
  bindJournal(journal: DelegationEdgeReader): void {
    this.journal = journal;
  }
  resolve(thread: Thread): Thread {
    if (thread.treeRootId !== undefined || thread.host !== undefined) return thread;
    const root = this.findRoot(thread);
    return root !== undefined && root !== thread.id ? { ...thread, treeRootId: root } : thread;
  }
  private findRoot(start: TreeRootAncestor): ThreadId | undefined {
    const seen = new Set<string>([start.id]);
    let current: TreeRootAncestor = start;
    for (let hop = 0; hop < maxWalkHops; hop++) {
      if (current.treeRootId !== undefined) return current.treeRootId;
      if (current.delegatedFrom !== undefined)
        return current.delegatedFrom.rootThreadId ?? current.delegatedFrom.threadId;
      const parentId =
        this.journal?.get(current.id)?.parentId ?? current.delegatedBy ?? current.startedBy;
      if (parentId === undefined || seen.has(parentId))
        return current.id === start.id ? undefined : current.id;
      const parent = this.readThread(parentId);
      if (parent === undefined) return parentId;
      if (parent.host !== undefined) return current.id === start.id ? undefined : current.id;
      seen.add(parentId);
      current = parent;
    }
    return current.id === start.id ? undefined : current.id;
  }
}
