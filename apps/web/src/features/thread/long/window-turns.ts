import type { JumpWindow } from "@ace/ui-core";
import { windowTurnOrdinals } from "@ace/ui-core";
import { useMemo } from "react";
import { blockOf, useTurnBlock } from "./turn-index.ts";

/**
 * Each item of a jumped window's root turn, from where the index says turns start. A window's
 * old items may outlive the client's runs, so their run ordinals can't be read; the three
 * blocks of turns around `anchor` (the turn being read) cover any window the reader is in.
 */
export function useWindowTurns(
  threadId: string,
  window: JumpWindow | undefined,
  anchor: number | undefined,
): ReadonlyMap<string, number> | undefined {
  const block = window && anchor !== undefined ? blockOf(anchor) : undefined;
  const before = useTurnBlock(threadId, block === undefined ? undefined : block - 1);
  const here = useTurnBlock(threadId, block);
  const after = useTurnBlock(threadId, block === undefined ? undefined : block + 1);
  return useMemo(() => {
    if (!window) return undefined;
    const starts = [];
    for (const turns of [before, here, after])
      for (const turn of turns?.values() ?? []) starts.push(turn);
    return windowTurnOrdinals(window, starts);
  }, [window, before, here, after]);
}
