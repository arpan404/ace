import type { EditorDocument } from "@ace/editor";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { arrivingView, claimFocus, leaveView, type ViewHandoff } from "./view-handoff.ts";
import type { RowLayout } from "./wrap-index.ts";

/**
 * Carries a view through a layout change that mounts it again (a split, a moved group, full
 * view): the leaving view hands over the line at its top edge and whether it had the keyboard;
 * the arriving view of the same document scrolls there and, if it had, takes the keyboard.
 */
export function useViewHandoff(options: {
  doc: EditorDocument | undefined;
  field: RefObject<HTMLTextAreaElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  layout: RowLayout | undefined;
  lineHeight: number;
  onScroll(scroll: { top: number; left: number }): void;
}): void {
  const { doc, field, scroller, layout, lineHeight, onScroll } = options;
  const latest = useRef({ layout, lineHeight });
  useLayoutEffect(() => {
    latest.current = { layout, lineHeight };
  });
  /** What arrived with this mount, waiting for the rows it scrolls to. */
  const arrived = useRef<ViewHandoff | undefined>(undefined);

  useLayoutEffect(() => {
    if (!doc) return undefined;
    // The text box and the scroller stay the same nodes for as long as the document does.
    const box = field.current;
    const element = scroller.current;
    // Leaving views of this document ran their cleanup earlier in this commit.
    const handoff = arrivingView(doc);
    arrived.current = handoff;
    if (handoff && claimFocus(doc)) box?.focus({ preventScroll: true });
    return () => {
      const { layout: rows, lineHeight: height } = latest.current;
      const topRow = Math.floor((element?.scrollTop ?? 0) / height);
      leaveView(doc, {
        topLine: rows ? rows.lineAt(topRow) : topRow,
        scrollLeft: element?.scrollLeft ?? 0,
        focused: box !== null && box === document.activeElement,
      });
    };
  }, [doc, field, scroller]);

  useLayoutEffect(() => {
    const handoff = arrived.current;
    const element = scroller.current;
    if (!handoff || !layout || !element) return;
    arrived.current = undefined;
    element.scrollTo({
      top: layout.startOf(handoff.topLine) * lineHeight,
      left: handoff.scrollLeft,
    });
    onScroll({ top: element.scrollTop, left: element.scrollLeft });
  });
}
