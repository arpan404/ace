import { ThreadId, type StorageReason } from "@ace/protocol";
import type { StorageOwner } from "./types.ts";
import type { Store } from "../store.ts";
import { builtinSkillLeaseUnused, type SkillProcessRuntime } from "../builtin-skill-processes.ts";

export function hasTable(store: Store, name: string): boolean {
  return Boolean(
    store.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

/** Durable delegation membership covers ancestors and siblings, including cold sessions. */
export function storageTree(store: Store, id: ThreadId): ThreadId[] {
  return storageMembers(store, [id]);
}

/**
 * Every thread in the delegation trees of `ids`. Each tree is read once, however many of its
 * members are asked about, so a large tree costs its size rather than its size squared.
 */
export function storageMembers(store: Store, ids: readonly ThreadId[]): ThreadId[] {
  if (!hasTable(store, "delegation_participants")) return [...new Set(ids)];
  const rootOf = store.statement("SELECT root_id FROM delegation_participants WHERE thread_id=?");
  const membersOf = store.statement(
    "SELECT thread_id FROM delegation_participants WHERE root_id=?",
  );
  const members = new Set<ThreadId>();
  const roots = new Set<string>();
  for (const id of ids) {
    members.add(id);
    const root = rootOf.get(id)?.root_id;
    if (typeof root !== "string" || roots.has(root)) continue;
    roots.add(root);
    // Every member, however large the tree: a partial tree would delete a parent while its
    // children still hold its worktree, or refuse to clean the tree at all.
    members.add(ThreadId.parse(root));
    for (const row of membersOf.all(root)) members.add(ThreadId.parse(row.thread_id));
  }
  return [...members];
}

/** Held, uncertain and admitted inputs are protected even when nothing is executing now. */
export function storageProtections(owner: StorageOwner, ids: readonly ThreadId[]): StorageReason[] {
  const { store, services } = owner;
  const reasons = new Set<StorageReason>();
  // Which optional tables exist is read once per call, not once per member and check.
  const has = {
    engineSessions: hasTable(store, "engine_sessions"),
    intents: hasTable(store, "intents"),
    engineQueue: hasTable(store, "engine_queue"),
    delegatedThreads: hasTable(store, "delegated_threads"),
    delegationReservations: hasTable(store, "delegation_reservations"),
    delegationTrees: hasTable(store, "delegation_trees"),
  };
  for (const id of storageMembers(store, ids)) {
    const thread = store.readThread(id);
    if (!thread) continue;
    if (thread.pinned) reasons.add("pinned");
    if (!["done", "failed", "new"].includes(thread.status.state)) reasons.add("active_tree");
    if (services.engine) {
      if (services.engine.hasSession(id)) reasons.add("leased");
      if (Object.values(services.engine.liveWork(id)).some((count) => count > 0))
        reasons.add("active_tree");
    } else if (has.engineSessions) reasons.add("owner_unavailable");
    if (services.workspaceActions?.hasOwnedWork(id) || services.browser?.hasActiveSession(id))
      reasons.add("active_tree");
    if (
      has.intents &&
      store
        .statement(`SELECT 1 FROM intents WHERE thread_id=?
      AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) LIMIT 1`)
        .get(id)
    )
      reasons.add("pending_input");
    if (
      has.engineQueue &&
      store
        .statement(
          "SELECT 1 FROM engine_queue WHERE thread_id=? AND (continuation IS NOT NULL OR resume_at IS NOT NULL)",
        )
        .get(id)
    )
      reasons.add("pending_input");
    if (
      has.delegatedThreads &&
      store
        .statement(
          "SELECT 1 FROM delegated_threads WHERE (child_id=? OR parent_id=?) AND (phase<>'settled' OR result_pending=1) LIMIT 1",
        )
        .get(id, id)
    )
      reasons.add("active_tree");
    if (
      has.delegationReservations &&
      store
        .statement("SELECT 1 FROM delegation_reservations WHERE parent_id=? OR child_id=? LIMIT 1")
        .get(id, id)
    )
      reasons.add("active_tree");
    if (
      has.delegationTrees &&
      store.statement("SELECT 1 FROM delegation_trees WHERE root_id=? AND active>0").get(id)
    )
      reasons.add("active_tree");
    if (
      store
        .statement("SELECT 1 FROM storage_cleanup_fences WHERE thread_id=? AND plan_id<>?")
        .get(id, owner.cleanupPlanId ?? "")
    )
      reasons.add("cleanup_in_progress");
    if (
      has.engineSessions &&
      store
        .statement(
          "SELECT 1 FROM workspace_root_reservations r JOIN engine_sessions s ON s.cwd=r.root WHERE s.thread_id=? AND r.command_id<>?",
        )
        .get(id, `storage:${owner.cleanupPlanId ?? ""}`)
    )
      reasons.add("cleanup_in_progress");
  }
  return [...reasons];
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
