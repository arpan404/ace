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
  const record = journal?.get(threadId);
  const root = record?.rootId ?? journal?.participant(threadId)?.root_id ?? threadId;
  const descendants = journal
    ? journal.family(root).filter((edge) => journal.isDescendant(edge.childId, threadId))
    : [];
  const members = [threadId, ...descendants.map((edge) => edge.childId)];
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

function delegatedChildPersisted(store: ServiceContext["store"], threadId: ThreadId): boolean {
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
