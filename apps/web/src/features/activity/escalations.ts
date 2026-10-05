import { gateDecision, type GateDecision } from "@ace/ui-core";
import { useDeckDecisions, type DeckDecision, type DeckOwner } from "@/features/deck/index.ts";
import type { FeedAction, FeedEvent } from "./feed-events.ts";

/** How a deck decision is answered, in the conductor's terms (`gateDecision`). */
function choiceOf(decision: DeckDecision): GateDecision {
  return gateDecision(decision.gate, decision.card);
}

/**
 * A decision a deck waits on, as a feed event; it stays in Needs you until the deck reports it
 * closed. A conductor gate is approved or rejected here with the Deck's own words; a gate that
 * needs a value (a raised budget, a later deadline) offers no approve here and is answered in
 * the deck. An agent's question carries its interaction and is answered like any other request.
 */
export function deckEvent(decision: DeckDecision): FeedEvent {
  const { gate } = decision;
  const choice = choiceOf(decision);
  const actions: FeedAction[] | undefined =
    gate.kind === "provider"
      ? undefined
      : [
          { id: "reject", label: choice.reject.label },
          ...(choice.approve
            ? [{ id: "approve" as const, label: choice.approve.label, primary: true }]
            : []),
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

/** The Deck's words for an Activity escalation: confirmations, toasts, what reject does. */
export function useDeckChoice(event: FeedEvent): GateDecision | undefined {
  const { decisions } = useDeckDecisions();
  const decision = decisions.find(
    (entry) => entry.runId === event.runId && entry.gate.id === event.gateId,
  );
  return decision && choiceOf(decision);
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
