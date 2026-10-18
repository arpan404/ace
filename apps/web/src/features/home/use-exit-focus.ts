import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";
import type { HomeRow } from "@ace/ui-core";
import { focusRowFrom } from "./list-focus.ts";

/** Where a row's menu or confirmation takes focus while it is open. */
const popups = '[role="menu"], [role="dialog"], [role="alertdialog"]';

interface DrawnRow {
  key: string | number;
  item: HomeRow;
  phase: string;
}

/**
 * When the row holding focus leaves the list (archived, settled, snoozed, from its menu or a
 * shortcut), focus moves on to the next row, or the one before when it was the last, instead of
 * falling back to the page. Returns the list's focus handlers that remember the focused row.
 */
export function useFocusAfterExit(
  viewport: RefObject<HTMLElement | null>,
  drawn: readonly DrawnRow[],
  mount: (index: number) => void,
) {
  const focused = useRef<{ key: string | number; index: number }>(undefined);
  const latest = useRef({ mount, drawn });
  useLayoutEffect(() => {
    latest.current = { mount, drawn };
  });
  useLayoutEffect(() => {
    const held = focused.current;
    const scroller = viewport.current;
    if (!held || !scroller) return;
    const index = drawn.findIndex((row) => row.key === held.key);
    const row = drawn[index];
    if (row && row.phase !== "exit") {
      focused.current = { key: held.key, index };
      return;
    }
    focused.current = undefined;
    const doc = scroller.ownerDocument;
    let frames = 60;
    const settle = () => {
      if (!scroller.isConnected) return;
      const active = doc.activeElement;
      // The row's menu is still closing: it hands focus back to the row first.
      if (active?.closest(popups) && --frames > 0) {
        requestAnimationFrame(settle);
        return;
      }
      // The rows as drawn now: the leaving row may have gone while a menu closed.
      const rows = latest.current.drawn;
      const at = rows.findIndex((each) => each.key === held.key);
      const box = at < 0 ? null : scroller.querySelector(`[data-index="${at}"]`);
      // Only when focus went with the row; never take it back from wherever it was moved.
      const lost = !active || active === doc.body || (box !== null && box.contains(active));
      if (!lost) return;
      // A leaving row still holds its place; one already gone has the next row in its place.
      const after = at < 0 ? held.index : at + 1;
      const before = (at < 0 ? held.index : at) - 1;
      const mountRow = (target: number) => latest.current.mount(target);
      void focusRowFrom({ viewport: scroller, rows, start: after, step: 1, mount: mountRow }).then(
        (landed) =>
          landed ??
          focusRowFrom({ viewport: scroller, rows, start: before, step: -1, mount: mountRow }),
      );
    };
    settle();
  }, [drawn, viewport]);
  return {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!(event.target instanceof Element)) return;
      const box = event.target.closest<HTMLElement>("[data-index]");
      const index = Number(box?.dataset.index);
      const row = Number.isInteger(index) ? drawn[index] : undefined;
      if (row) focused.current = { key: row.key, index };
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      // Focus moved somewhere the person chose: forget the row. A row turning inert blurs
      // with nowhere to go, and is followed by the move above.
      if (!(next instanceof Element) || event.currentTarget.contains(next)) return;
      // A row's own menu or a question it asks hands focus back; keep the row meanwhile.
      if (!next.closest(popups)) focused.current = undefined;
    },
  };
}
