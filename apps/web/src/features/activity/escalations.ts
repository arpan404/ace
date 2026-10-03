import { useDeckDecisions, type DeckDecision, type DeckOwner } from "@/features/deck/index.ts";
import type { FeedAction, FeedEvent } from "./feed-events.ts";

const approve: Record<"plan" | "merge" | "escalation", string> = {
  plan: "Approve plan",
  merge: "Approve merge",
  escalation: "Approve",
};

/**
 * A decision a deck waits on, as a feed event; it stays in Needs you until the deck reports it
 * closed. A conductor gate is approved or rejected here; an agent's question carries its
 * interaction and is answered like any other request.
 */
export function deckEvent(decision: DeckDecision): FeedEvent {
  const { gate } = decision;
  const actions: FeedAction[] | undefined =
    gate.kind === "provider"
      ? undefined
      : [
          { id: "reject", label: "Reject" },
          { id: "approve", label: approve[gate.kind], primary: true },
        ];
  return {
    id: `escalation:${decision.runId}:${gate.id}`,
    kind: "escalation",
    title: gate.title,
    project: decision.workspaceId,
    context: decision.deck,
    at: gate.gatedAt,
    body: gate.body,
    ...(actions ? { actions } : {}),
    ...(gate.interaction ? { interaction: gate.interaction } : {}),
    runId: decision.runId,
    gateId: gate.id,
  };
}

/** Open Deck decisions as feed events, and the threads whose requests they stand for. */
export function useDeckEvents(): {
  events: FeedEvent[];
  threads: ReadonlyMap<string, DeckOwner>;
} {
  const { decisions, threads } = useDeckDecisions();
  return { events: decisions.map(deckEvent), threads };
}

/** Open Deck decisions, as feed events. */
export function useEscalations(): FeedEvent[] {
  return useDeckEvents().events;
}
