import { createContext, useContext, type ComponentType } from "react";

/**
 * Pieces of other slices a workspace tab draws with, handed down by whoever renders the thread
 * screen: the thread slice gives its transcript blocks, the thread route gives Deck's lane views
 * (`features/thread` and `features/deck` reach the panels, so the panels can't import them back).
 * Each is optional; a tab without its part says what it can't show here.
 */
export interface ThreadParts {
  /** One agent's own work in a thread, or a whole (child) thread when `agentId` is left out. */
  AgentTranscript?: ComponentType<{ threadId: string; agentId?: string | undefined }>;
  /** One deck lane: worker, reviewer, rounds and delegated agents. */
  DeckLane?: ComponentType<{ runId: string; cardId: string }>;
  /** The thread composer's shape for a side chat, off with `reason` while it can't run. */
  SideChatComposer?: ComponentType<{
    threadId: string;
    reason: string;
    reasonId: string;
    short?: string | undefined;
  }>;
  /** The deck a thread works for, with its lanes. */
  DeckOfThread?: ComponentType<{
    runId: string;
    threadId: string;
    onOpenLane(lane: { runId: string; cardId: string; title: string }): void;
  }>;
}

const ThreadPartsContext = createContext<ThreadParts>({});
export const ThreadPartsProvider = ThreadPartsContext.Provider;

/** The parts provided above this tab (empty outside a thread screen). */
export function useThreadParts(): ThreadParts {
  return useContext(ThreadPartsContext);
}

/** The workspace tab that shows one deck lane (`deck-lane` kind, id `run/card`). */
export function deckLaneTab(lane: { runId: string; cardId: string; title: string }) {
  return {
    kind: "deck-lane",
    id: `${lane.runId}/${lane.cardId}`,
    title: lane.title,
    data: { runId: lane.runId, cardId: lane.cardId },
  };
}
