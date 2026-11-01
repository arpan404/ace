import { useCallback, useLayoutEffect, useRef, type FocusEvent } from "react";

/**
 * Keeps the keyboard in the agent tree when the focused row goes away under it: an agent that
 * finishes folds into an "N done" line, or remounts inside an open one. After every render, if
 * the row that had focus left the page and focus fell to the body, the row now standing for it
 * (`active`) takes the focus. A person who left the tree on purpose (a click elsewhere, Tab out)
 * blurred a row still in the page: that is forgotten, and their focus is never taken back.
 */
export function useKeptFocus(active: string | undefined) {
  const tree = useRef<HTMLUListElement>(null);
  const focused = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const had = focused.current;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!had || had.isConnected || !lost || active === undefined) return;
    focused.current = null;
    const rows = tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [];
    for (const row of rows) if (row.dataset.row === active) return row.focus();
  });
  const onFocus = useCallback((event: FocusEvent<HTMLUListElement>) => {
    focused.current = event.target;
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLUListElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    // Still in the page: the person moved away. Removed while focused: keep it to recover.
    if (event.target.isConnected) focused.current = null;
  }, []);
  return { tree, onFocus, onBlur };
}
