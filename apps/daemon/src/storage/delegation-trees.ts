import type { StorageReason, ThreadId } from "@ace/protocol";

/** One `delegation_participants` row: a thread and the root of the delegation tree it joined. */
export interface DelegationRow {
  threadId: ThreadId;
  rootId: ThreadId;
}

/** Rule order, so reasons read the same whichever member contributed them. */
const reasonOrder: readonly StorageReason[] = [
  "pinned",
  "active_tree",
  "leased",
  "owner_unavailable",
  "pending_input",
  "cleanup_in_progress",
];
const rank = (reason: StorageReason) => {
  const index = reasonOrder.indexOf(reason);
  return index < 0 ? reasonOrder.length : index;
};

/**
 * Delegation membership held in memory. A thread's storage tree is itself, its root, and every
 * participant of that root, including cold sessions; a thread with no participant row is alone.
 * Built from rows that cover every queried thread and every participant of their roots.
 */
export class DelegationTrees {
  private readonly roots = new Map<ThreadId, ThreadId>();
  private readonly participants = new Map<ThreadId, Set<ThreadId>>();
  constructor(rows: Iterable<DelegationRow>) {
    for (const row of rows) this.add(row);
  }
  /** Records a thread's root and lists it among the root's participants, in arrival order. */
  add(row: DelegationRow): void {
    this.assign(row);
    const members = this.participants.get(row.rootId);
    if (members) members.add(row.threadId);
    else this.participants.set(row.rootId, new Set([row.threadId]));
  }
  /**
   * Records only a thread's root. Loaders use it for rows read by thread, so a tree lists its
   * participants in the order the root's own read returned them, whichever thread asked first.
   */
  assign(row: DelegationRow): void {
    if (!this.roots.has(row.threadId)) this.roots.set(row.threadId, row.rootId);
  }
  rootOf(id: ThreadId): ThreadId | undefined {
    return this.roots.get(id);
  }
  /** Every member, however large the tree: a partial tree would delete a parent while its
   * children still hold its worktree, or refuse to clean the tree at all. */
  tree(id: ThreadId): ThreadId[] {
    const root = this.roots.get(id);
    if (root === undefined) return [id];
    return [...new Set([id, root, ...(this.participants.get(root) ?? [])])];
  }
  /** The union of each thread's tree, in first-seen order. */
  members(ids: Iterable<ThreadId>): ThreadId[] {
    const members = new Set<ThreadId>();
    const expanded = new Set<ThreadId>();
    for (const id of ids) {
      members.add(id);
      const root = this.roots.get(id);
      if (root === undefined || expanded.has(root)) continue;
      // Every participant of a root shares that root's tree: list it once.
      expanded.add(root);
      members.add(root);
      for (const member of this.participants.get(root) ?? []) members.add(member);
    }
    return [...members];
  }
  /** Participants of `root`, without the root itself unless it has its own row. */
  participantsOf(root: ThreadId): Iterable<ThreadId> {
    return this.participants.get(root) ?? [];
  }
}

/**
 * Reasons that keep any member of the given threads' trees: the union of every member's own
 * reasons. Each root's participant union is computed once, so the cost is linear in the
 * number of threads however many of them share a tree. Threads absent from `reasons` have no
 * thread row and contribute nothing.
 */
export function treeProtections(
  trees: DelegationTrees,
  reasons: ReadonlyMap<ThreadId, ReadonlySet<StorageReason>>,
  ids: Iterable<ThreadId>,
  memo: Map<ThreadId, ReadonlySet<StorageReason>> = new Map(),
): StorageReason[] {
  const found = new Set<StorageReason>();
  const take = (id: ThreadId) => {
    for (const reason of reasons.get(id) ?? []) found.add(reason);
  };
  for (const id of ids) {
    take(id);
    const root = trees.rootOf(id);
    if (root === undefined) continue;
    take(root);
    let group = memo.get(root);
    if (!group) {
      const union = new Set<StorageReason>();
      for (const member of trees.participantsOf(root))
        for (const reason of reasons.get(member) ?? []) union.add(reason);
      group = union;
      memo.set(root, group);
    }
    for (const reason of group) found.add(reason);
  }
  return [...found].toSorted((a, b) => rank(a) - rank(b));
}
