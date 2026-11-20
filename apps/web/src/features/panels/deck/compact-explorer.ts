import { useEffect, useState } from "react";
import { compactBelowPx } from "@/features/editor-workbench/index.ts";
import { settleExplorerAsk, useExplorerAsk } from "@/lib/workspace/index.ts";

/**
 * Whether a compact Deck lays its explorer over the editor (spec 5): toggled by "Show files",
 * and shown when an opener asks for the explorer (`findInDeck`). The ask waits until the Deck has
 * measured; a wide Deck takes it too, its explorer already shown from the layout.
 */
export function useCompactExplorer(thread: string, width: number, initiallyShown: boolean) {
  const [shown, setShown] = useState(initiallyShown);
  const [taken, setTaken] = useState<number | undefined>(undefined);
  const ask = useExplorerAsk(thread);
  const measured = width > 0;
  if (ask !== undefined && measured && ask !== taken) {
    setTaken(ask);
    if (width < compactBelowPx) setShown(true);
  }
  useEffect(() => {
    if (taken !== undefined) settleExplorerAsk(thread, taken);
  }, [thread, taken]);
  return { shown, setShown };
}
