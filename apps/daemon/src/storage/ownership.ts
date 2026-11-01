import { ThreadId, type StorageReason } from "@ace/protocol";
import type { StorageOwner } from "./types.ts";
import type { Store } from "../store.ts";
import type { FrozenThread } from "../thread-cache.ts";
import { DelegationTrees, treeProtections } from "./delegation-trees.ts";
import { builtinSkillLeaseUnused, type SkillProcessRuntime } from "../builtin-skill-processes.ts";

export function hasTable(store: Store, name: string): boolean {
  return Boolean(
    store.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

const each = "(SELECT value FROM json_each(?))";

/**
 * Loads delegation membership for `ids` with a bounded number of queries: their rows, every
 * participant of their roots, and the same again for those members, so the trees of every
 * member of every tree are also known.
 */
export function loadDelegationTrees(store: Store, ids: readonly ThreadId[]): DelegationTrees {
  const trees = new DelegationTrees([]);
  if (!hasTable(store, "delegation_participants")) return trees;
  const read = (rows: readonly Record<string, unknown>[], listed: boolean) => {
    // A row without a root leaves its thread alone in its tree.
    for (const row of rows) {
      if (typeof row.root_id !== "string") continue;
      const parsed = {
        threadId: ThreadId.parse(row.thread_id),
        rootId: ThreadId.parse(row.root_id),
      };
      if (listed) trees.add(parsed);
      else trees.assign(parsed);
    }
  };
  const checked = new Set<ThreadId>();
  const loadedRoots = new Set<ThreadId>();
  let pending = [...new Set(ids)];
  for (let level = 0; level < 2 && pending.length; level++) {
    // A participant row is keyed by thread, so a thread whose row was read is complete.
    const unread = pending.filter((id) => !checked.has(id) && trees.rootOf(id) === undefined);
    for (const id of unread) checked.add(id);
    if (unread.length)
      read(
        store
          .statement(
            `SELECT thread_id,root_id FROM delegation_participants WHERE thread_id IN ${each}`,
          )
          .all(JSON.stringify(unread)),
        false,
      );
    const roots = [
      ...new Set(
        pending.flatMap((id) => {
          const root = trees.rootOf(id);
          return root === undefined || loadedRoots.has(root) ? [] : [root];
        }),
      ),
    ];
    for (const root of roots) loadedRoots.add(root);
    if (roots.length)
      read(
        store
          .statement(
            `SELECT thread_id,root_id FROM delegation_participants WHERE root_id IN ${each}`,
          )
          .all(JSON.stringify(roots)),
        true,
      );
    pending = trees.members(pending);
  }
  return trees;
}

/** Durable delegation membership covers ancestors and siblings, including cold sessions. */
export function storageTree(store: Store, id: ThreadId): ThreadId[] {
  return loadDelegationTrees(store, [id]).tree(id);
}

/** The union of the storage trees of `ids`. */
export function storageMembers(store: Store, ids: readonly ThreadId[]): ThreadId[] {
  return loadDelegationTrees(store, ids).members(ids);
}

/** Every string a query returns, for queries that select thread ids. */
function matching(
  store: Store,
  sql: string,
  ids: readonly ThreadId[],
  ...extra: string[]
): Set<string> {
  const found = new Set<string>();
  for (const row of store.statement(sql).all(JSON.stringify(ids), ...extra))
    for (const value of Object.values(row)) if (typeof value === "string") found.add(value);
  return found;
}

/**
 * Each existing thread's own reasons to be kept, read with a bounded number of queries
 * whatever the number of threads. Held, uncertain and admitted inputs are protected even
 * when nothing is executing now. A thread without a row has no entry.
 */
export function threadReasons(
  owner: StorageOwner,
  rows: ReadonlyMap<ThreadId, FrozenThread>,
): Map<ThreadId, Set<StorageReason>> {
  const { store, services } = owner;
  const reasons = new Map<ThreadId, Set<StorageReason>>();
  const threads = [...rows.keys()];
  if (!threads.length) return reasons;
  const sessions = hasTable(store, "engine_sessions");
  for (const [id, thread] of rows) {
    const own = new Set<StorageReason>();
    reasons.set(id, own);
    if (thread.pinned) own.add("pinned");
    if (!["done", "failed", "new"].includes(thread.status.state)) own.add("active_tree");
    if (services.engine) {
      if (services.engine.hasSession(id)) own.add("leased");
      if (Object.values(services.engine.liveWork(id)).some((count) => count > 0))
        own.add("active_tree");
    } else if (sessions) own.add("owner_unavailable");
    if (services.workspaceActions?.hasOwnedWork(id) || services.browser?.hasActiveSession(id))
      own.add("active_tree");
  }
  const mark = (found: Set<string>, reason: StorageReason) => {
    for (const id of threads) if (found.has(id)) reasons.get(id)?.add(reason);
  };
  if (hasTable(store, "intents"))
    mark(
      matching(
        store,
        `SELECT DISTINCT thread_id FROM intents WHERE thread_id IN ${each}
        AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1)`,
        threads,
      ),
      "pending_input",
    );
  if (hasTable(store, "engine_queue"))
    mark(
      matching(
        store,
        `SELECT DISTINCT thread_id FROM engine_queue WHERE thread_id IN ${each}
        AND (continuation IS NOT NULL OR resume_at IS NOT NULL)`,
        threads,
      ),
      "pending_input",
    );
  if (hasTable(store, "delegated_threads"))
    mark(
      matching(
        store,
        `SELECT child_id,parent_id FROM delegated_threads WHERE (child_id IN ${each} OR parent_id IN ${each})
        AND (phase<>'settled' OR result_pending=1)`,
        threads,
        JSON.stringify(threads),
      ),
      "active_tree",
    );
  if (hasTable(store, "delegation_reservations"))
    mark(
      matching(
        store,
        `SELECT child_id,parent_id FROM delegation_reservations WHERE parent_id IN ${each} OR child_id IN ${each}`,
        threads,
        JSON.stringify(threads),
      ),
      "active_tree",
    );
  if (hasTable(store, "delegation_trees"))
    mark(
      matching(
        store,
        `SELECT root_id FROM delegation_trees WHERE root_id IN ${each} AND active>0`,
        threads,
      ),
      "active_tree",
    );
  mark(
    matching(
      store,
      `SELECT thread_id FROM storage_cleanup_fences WHERE thread_id IN ${each} AND plan_id<>?`,
      threads,
      owner.cleanupPlanId ?? "",
    ),
    "cleanup_in_progress",
  );
  if (sessions)
    mark(
      matching(
        store,
        `SELECT DISTINCT s.thread_id FROM workspace_root_reservations r JOIN engine_sessions s ON s.cwd=r.root
        WHERE s.thread_id IN ${each} AND r.command_id<>?`,
        threads,
        `storage:${owner.cleanupPlanId ?? ""}`,
      ),
      "cleanup_in_progress",
    );
  return reasons;
}

/** Facts for many storage candidates read at once, then evaluated in memory. */
export interface ProtectionFacts {
  trees: DelegationTrees;
  /** Every member's thread row; a member without a row has no entry. */
  threads: Map<ThreadId, FrozenThread>;
  reasons: Map<ThreadId, Set<StorageReason>>;
  memo: Map<ThreadId, ReadonlySet<StorageReason>>;
}

/** Reads the trees of `ids` and every member's own reasons, without awaiting. */
export function loadProtectionFacts(
  owner: StorageOwner,
  ids: readonly ThreadId[],
): ProtectionFacts {
  const trees = loadDelegationTrees(owner.store, ids);
  // Members of members: a candidate's protections cover the trees of its whole tree.
  const threads = owner.store.readThreads(trees.members(trees.members(ids)));
  return { trees, threads, reasons: threadReasons(owner, threads), memo: new Map() };
}

/** Reasons that keep any member of the storage trees of `ids`. */
export function storageProtections(owner: StorageOwner, ids: readonly ThreadId[]): StorageReason[] {
  const facts = loadProtectionFacts(owner, ids);
  return treeProtections(facts.trees, facts.reasons, ids);
}

/** A built-in skill root is owned by its process lease. Missing or unverifiable evidence retains it. */
export function skillRootProtections(
  readLease: () => string,
  runtime?: SkillProcessRuntime,
): StorageReason[] {
  try {
    return builtinSkillLeaseUnused(readLease(), runtime) ? [] : ["leased"];
  } catch {
    return ["owner_unavailable"];
  }
}
