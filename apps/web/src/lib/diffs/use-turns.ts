import type { ThreadKey } from "@ace/client";
import { useItemOrder, useThread } from "@ace/client-react";
import { useMemo } from "react";
import { collectTurns, turnsEqual, type Turn } from "@ace/ui-core";
import { useDiffStat } from "./use-file-diffs.ts";

const noTurns: readonly Turn[] = [];

/**
 * The thread's root turns with their file edits, from the live store. Re-selects when an
 * item in the loaded window changes and re-renders only when the set of edits does.
 */
export function useTurns(threadId: string): readonly Turn[] {
  const order = useItemOrder(threadId);
  const keys = useMemo<ThreadKey[]>(
    () => ["order", "thread", "agents", ...(order ?? []).map((id): ThreadKey => `item:${id}`)],
    [order],
  );
  return useThread(threadId, keys, collectTurns, turnsEqual) ?? noTurns;
}

/** Lines added and removed across the whole thread: the Changes tab and the work card. */
export function useThreadDiffStat(threadId: string): { additions: number; deletions: number } {
  const turns = useTurns(threadId);
  const edits = useMemo(() => turns.flatMap((turn) => turn.edits), [turns]);
  return useDiffStat(edits);
}
