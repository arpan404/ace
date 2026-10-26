import type { Fact, ThreadState } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/**
 * The thread a native fork's opening session is bringing turns from, while it opens: a
 * provider that carries the source's turns into the fork (Codex) translates them then, before
 * ace delivers anything. Undefined for any other open, such as an account move of the thread's
 * own session.
 */
export function forkReplaySource(repo: EngineRepository, id: ThreadId): ThreadId | undefined {
  if (!repo.transitions.get(id).fork?.inherited) return undefined;
  return repo.store.getThread(id)?.lineage?.parentThreadId;
}

/**
 * What a provider's fork brings along of the source's turns. A notice or error the provider
 * reports while the fork opens is about the fork itself and stays its own.
 */
const replayedKinds = new Set(["message", "tool_call", "reasoning", "compaction"]);

/**
 * An item the opening fork's provider translated from the source (a message, a step, its
 * reasoning), marked as the source's like ace's own copies. Only new items: one that already
 * exists keeps what it was.
 */
export function inheritedReplay(fact: Fact, source: ThreadId, state: ThreadState): Fact {
  if (fact.type !== "item.upsert" && fact.type !== "item.reconciled") return fact;
  if (!replayedKinds.has(fact.draft.type) || fact.draft.inherited) return fact;
  if (Object.hasOwn(state.items, fact.item)) return fact;
  return { ...fact, draft: { ...fact.draft, inherited: { threadId: source } } };
}
