import { CliTree, type ThreadId } from "@ace/protocol";
import { threadAttention } from "@ace/projection";
import type { ServiceContext } from "./services/types.ts";
/** Authoritative bounded tree facts for every daemon observer. */
export function readThreadTree(
  context: Pick<ServiceContext, "store" | "services">,
  threadId: ThreadId,
): CliTree | undefined {
  const { store, services } = context;
  if (!services.engine || !store.getThread(threadId)) return undefined;
  const journal = services.agentControl?.delegations.journal;
  // Without agent control the thread is its whole tree only when no delegated child was
  // ever persisted for it; otherwise its children's facts are not ready yet.
  if (!journal && delegatedChildPersisted(store, threadId)) return undefined;
  const descendants = journal?.descendants(threadId) ?? [];
  return readTreeMembers(context, [threadId, ...descendants.map((edge) => edge.childId)]);
}

/** Tree facts for exactly these threads, as `readThreadTree` reads each member. */
export function readTreeMembers(
  context: Pick<ServiceContext, "store" | "services">,
  members: readonly ThreadId[],
  journal = context.services.agentControl?.delegations.journal,
): CliTree {
  const { store, services } = context;
  const data = members.map((id) => {
    const value = store.getThread(id);
    const edge = journal?.get(id);
    const snapshot = services.engine?.queue(id);
    const queue = value?.queue ?? snapshot;
    return {
      threadId: id,
      status: value?.status ?? { state: "unresponsive" as const },
      pending: !!edge && edge.phase !== "settled",
      queue: queue && {
        ...queue,
        uncertain: snapshot?.messages.some((message) => message.state === "uncertain") ?? false,
      },
      attention: threadAttention({ queue }),
      cancelled: queue?.lastFailure?.code === "cancelled" || edge?.outcome?.outcome === "cancelled",
    };
  });
  return CliTree.parse(data);
}

export function delegatedChildPersisted(
  store: ServiceContext["store"],
  threadId: ThreadId,
): boolean {
  return store.atomic((db) => {
    const journal = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delegated_threads'")
      .get();
    return (
      journal !== undefined &&
      db.prepare("SELECT 1 FROM delegated_threads WHERE parent_id=? LIMIT 1").get(threadId) !==
        undefined
    );
  });
}
