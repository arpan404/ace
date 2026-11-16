import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/** A thread named for an agent: its id, and its title when it has one. */
interface Named {
  threadId: ThreadId;
  title?: string;
}

/**
 * Who owns a thread, for agents reading it: the parent that delegated it and its top-level
 * thread, or the thread whose agent started it. An agent that can't message a finished child
 * directly learns here which thread its message reaches instead. Empty for the person's own.
 */
export type Lineage = { parent: Named; root: Named } | { startedBy: Named } | Record<string, never>;

export function threadLineage(store: Store, journal: DelegationJournal, id: ThreadId): Lineage {
  const named = (threadId: ThreadId): Named => {
    const title = store.getThread(threadId)?.title;
    return title ? { threadId, title } : { threadId };
  };
  const edge = journal.get(id);
  if (edge) return { parent: named(edge.parentId), root: named(edge.rootId) };
  const startedBy = store.getThread(id)?.startedBy;
  return startedBy ? { startedBy: named(startedBy) } : {};
}

/** The same, as ids only, for a search hit that must stay small. */
export function lineageIds(journal: DelegationJournal, id: ThreadId) {
  const edge = journal.get(id);
  return edge ? { parentThreadId: edge.parentId, rootThreadId: edge.rootId } : {};
}

/** For a refused change to another agent's child: the thread that owns it, to message instead. */
export function ownerHint(journal: DelegationJournal, id: ThreadId): { hint?: string } {
  const edge = journal.get(id);
  return edge
    ? {
        hint: `Only the thread that delegated it may change it. It belongs to the top-level thread ${edge.rootId}: message it, or this one, with agent_message.`,
      }
    : {};
}
