import { useCallback, useLayoutEffect, useRef, type FocusEvent } from "react";

/** A row that left the page, or is still on it only to play its exit. */
const leaving = (row: Element) => !row.isConnected || row.closest("[inert]") !== null;

/** The tree's rows a person can reach, in order: rows still playing their exit are inert. */
export function treeItems(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
    (row) => !row.closest("[inert]"),
  );
}

/**
 * Keeps the keyboard in the agent tree when the focused row goes away under it: an agent that
 * finishes folds into an "N done" line, or remounts inside an open one. After every render, if
 * the row that had focus left the page or is fading out (inert), and focus fell to the body or
 * stayed on that row, the row now standing for it (`active`) takes the focus. A person who left the tree on purpose (a click elsewhere, Tab out)
 * blurred a row still in the page: that is forgotten, and their focus is never taken back.
 */
export function useKeptFocus(active: string | undefined) {
  const tree = useRef<HTMLUListElement>(null);
  const focused = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const had = focused.current;
    if (!had || active === undefined || !leaving(had)) return;
    const now = document.activeElement;
    if (now !== null && now !== document.body && now !== had) return;
    focused.current = null;
    const rows = tree.current ? treeItems(tree.current) : [];
    for (const row of rows) if (row.dataset.row === active) return row.focus();
  });
  const onFocus = useCallback((event: FocusEvent<HTMLUListElement>) => {
    focused.current = event.target;
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLUListElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    // Still in the page: the person moved away. Removed or fading out: keep it to recover.
    if (!leaving(event.target)) focused.current = null;
  }, []);
  return { tree, onFocus, onBlur };
}
