import { deckGates, deckTitle, type Gate } from "@ace/ui-core";
import type { ConductorRunView } from "@ace/protocol";
import { useDeckSnapshot } from "./use-deck-store.ts";

/** A decision a deck waits on: its plan, a merge, an escalation or an agent's question. */
export interface DeckDecision {
  runId: string;
  workspaceId: string;
  /** The deck's title. */
  deck: string;
  gate: Gate;
}

/** The deck a thread works for. */
export interface DeckOwner {
  runId: string;
  workspaceId: string;
  deck: string;
}

export interface DeckDecisions {
  decisions: readonly DeckDecision[];
  /**
   * Every thread a deck owns, with its deck: the deck's own thread and each delegated one.
   * Their open requests are the decisions above, so Activity lists them once, as the deck's.
   */
  threads: ReadonlyMap<string, DeckOwner>;
}

function ownThreads(view: ConductorRunView, into: Map<string, DeckOwner>): void {
  const owner = { runId: view.id, workspaceId: view.workspaceId, deck: deckTitle(view.goal) };
  const delegated = new Set(view.delegations.map((delegation) => delegation.threadId));
  for (const delegation of view.delegations) {
    into.set(delegation.threadId, owner);
    // The deck's own thread is the parent no delegation of the deck accounts for.
    if (!delegated.has(delegation.parentThreadId)) into.set(delegation.parentThreadId, owner);
  }
}

/** Every open decision across the daemon's decks, for Activity's Needs you and the rail. */
export function useDeckDecisions(): DeckDecisions {
  const snapshot = useDeckSnapshot();
  const threads = new Map<string, DeckOwner>();
  const decisions = snapshot.entries.flatMap((entry) => {
    const view = entry.view;
    if (!view) return [];
    ownThreads(view, threads);
    return deckGates(view).map((gate) => ({
      runId: view.id,
      workspaceId: view.workspaceId,
      deck: deckTitle(view.goal),
      gate,
    }));
  });
  return { decisions, threads };
}
