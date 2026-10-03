import { deckGate, deckTitle, type Gate } from "@ace/ui-core";
import { useDeckSnapshot } from "./use-deck-store.ts";

/** A decision a deck escalated to a person: a lane that keeps failing, a budget, a deadline. */
export interface DeckEscalation {
  runId: string;
  workspaceId: string;
  /** The deck's title. */
  deck: string;
  gate: Gate;
  /** When this client first saw it; the conductor view carries no timestamps. */
  seenAt: number;
}

/** Every open escalation across the daemon's decks, for Activity's Needs you. */
export function useDeckEscalations(): DeckEscalation[] {
  const snapshot = useDeckSnapshot();
  return snapshot.entries.flatMap((entry) => {
    const gate = entry.view && deckGate(entry.view);
    if (!entry.view || gate?.kind !== "escalation") return [];
    return [
      {
        runId: entry.view.id,
        workspaceId: entry.view.workspaceId,
        deck: deckTitle(entry.view.goal),
        gate,
        seenAt: snapshot.seen.get(gate.id) ?? 0,
      },
    ];
  });
}
