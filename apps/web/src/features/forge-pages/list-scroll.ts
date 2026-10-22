import { useEffect, useLayoutEffect, useRef } from "react";
import { readJson, writeJson } from "@ace/ui-core";
import { z } from "zod";
import { useLayout } from "@/lib/layout.tsx";

const Kept = z.object({ address: z.string().max(4096), top: z.number().nonnegative() });

/**
 * Where a list was scrolled when it was left, for its own address only (filters, sort, search),
 * kept on this device: coming back from a pull request or issue puts the rows where they were.
 * One position per list, so a different filter set starts at the top.
 */
export function useListScroll(kind: "inbox" | "pulls" | "issues", address: string, ready: boolean) {
  const { storage } = useLayout();
  const key = `ace.forge.scroll.${kind}`;
  const element = useRef<HTMLDivElement | null>(null);
  const top = useRef(0);
  const restored = useRef<string | undefined>(undefined);
  // Back to where it was, once the rows that make it that tall have loaded.
  useLayoutEffect(() => {
    const scroller = element.current;
    if (!scroller || !ready || restored.current === address) return;
    restored.current = address;
    const kept = readJson(storage, key, Kept, { address: "", top: 0 });
    if (kept.address === address && kept.top > 0) scroller.scrollTop = kept.top;
  });
  // Written as the list is left (or its address changes), not on every scroll.
  useEffect(
    () => () => writeJson(storage, key, { address, top: top.current }),
    [storage, key, address],
  );
  return {
    ref: element,
    onScroll: (scrollTop: number) => {
      top.current = scrollTop;
    },
  };
}
