import type { ForkPoint } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { createContext, use, useCallback } from "react";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/** Where a fork starts, in the fork draft's address: `?run=` for a turn, `?item=` for an answer. */
export type ForkDraftSearch = { run?: string | undefined; item?: string | undefined };
export const forkDraftSearch = (point: ForkPoint): ForkDraftSearch =>
  point.type === "turn" ? { run: point.runId } : { item: point.itemId };

/**
 * Opens the fork of a thread at a point: a thread of its own, ready for the person's first
 * message, which starts it. Nothing is created until that message is sent.
 */
export function useOpenFork() {
  const navigate = useNavigate();
  const machine = useMachineSearch();
  return useCallback(
    (threadId: string, point: ForkPoint) =>
      void navigate({
        to: "/t/$threadId/fork",
        params: { threadId },
        search: { ...forkDraftSearch(point), ...machine },
      }),
    [navigate, machine],
  );
}

/** Opens this thread's fork at a point; provided by the thread screen, used by its messages. */
export const ForkOpener = createContext<((point: ForkPoint) => void) | undefined>(undefined);
export const useForkOpener = () => use(ForkOpener);
