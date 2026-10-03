import { useDeckEscalations, type DeckEscalation } from "@/features/deck/index.ts";
import type { FeedEvent } from "./feed-events.ts";

/** A deck's escalated decision; it stays in Needs you until the deck reports it closed. */
export function escalationEvent(escalation: DeckEscalation): FeedEvent {
  return {
    id: `escalation:${escalation.runId}:${escalation.gate.id}`,
    kind: "escalation",
    title: escalation.gate.title,
    project: escalation.workspaceId,
    context: escalation.deck,
    at: escalation.seenAt,
    body: escalation.gate.body,
    actions: [
      { id: "reject", label: "Reject" },
      { id: "approve", label: "Approve", primary: true },
    ],
    runId: escalation.runId,
    gateId: escalation.gate.id,
  };
}

/** Open Deck escalations, as feed events: what the rail counts beside open requests. */
export function useEscalations(): FeedEvent[] {
  return useDeckEscalations().map(escalationEvent);
}
