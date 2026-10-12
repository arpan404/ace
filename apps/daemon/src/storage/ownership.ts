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
  if (!hasTable(store, "delegation_participants")) return [id];
  const root = store
    .statement("SELECT root_id FROM delegation_participants WHERE thread_id=?")
    .get(id)?.root_id;
  if (typeof root !== "string") return [id];
  const rows = store
    .statement("SELECT thread_id FROM delegation_participants WHERE root_id=? LIMIT 257")
    .all(root);
  if (rows.length > 256) throw new Error("storage_tree_limit");
  return [
    ...new Set([id, ThreadId.parse(root), ...rows.map((row) => ThreadId.parse(row.thread_id))]),
  ];
}

/** Held, uncertain and admitted inputs are protected even when nothing is executing now. */
export function storageProtections(owner: StorageOwner, ids: readonly ThreadId[]): StorageReason[] {
  const { store, services } = owner;
  const reasons = new Set<StorageReason>();
  const members = new Set(ids.flatMap((id) => storageTree(store, id)));
  for (const id of members) {
    const thread = store.getThread(id);
    if (!thread) continue;
    if (thread.pinned) reasons.add("pinned");
    if (!["done", "failed", "new"].includes(thread.status.state)) reasons.add("active_tree");
    if (services.engine) {
      if (services.engine.hasSession(id)) reasons.add("leased");
      if (Object.values(services.engine.liveWork(id)).some((count) => count > 0))
        reasons.add("active_tree");
    } else if (hasTable(store, "engine_sessions")) reasons.add("owner_unavailable");
    if (services.workspaceActions?.hasOwnedWork(id) || services.browser?.hasActiveSession(id))
      reasons.add("active_tree");
    if (
      hasTable(store, "intents") &&
      store
        .statement(`SELECT 1 FROM intents WHERE thread_id=?
      AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) LIMIT 1`)
        .get(id)
    )
      reasons.add("pending_input");
    if (
      hasTable(store, "engine_queue") &&
      store
        .statement(
          "SELECT 1 FROM engine_queue WHERE thread_id=? AND (continuation IS NOT NULL OR resume_at IS NOT NULL)",
        )
        .get(id)
    )
      reasons.add("pending_input");
    if (
      hasTable(store, "delegated_threads") &&
      store
        .statement(
          "SELECT 1 FROM delegated_threads WHERE (child_id=? OR parent_id=?) AND (phase<>'settled' OR result_pending=1) LIMIT 1",
        )
        .get(id, id)
    )
      reasons.add("active_tree");
    if (
      hasTable(store, "delegation_reservations") &&
      store
        .statement("SELECT 1 FROM delegation_reservations WHERE parent_id=? OR child_id=? LIMIT 1")
        .get(id, id)
    )
      reasons.add("active_tree");
    if (
      hasTable(store, "delegation_trees") &&
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
      hasTable(store, "engine_sessions") &&
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
