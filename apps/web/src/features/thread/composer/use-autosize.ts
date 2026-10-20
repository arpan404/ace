import { useLayoutEffect, type RefObject } from "react";
import { inputLine, inputMinLines } from "./composer-styles.ts";

/**
 * How many lines the editor's content takes. Its contents' own box is read where the browser
 * can give it, so the editor never collapses to `auto` and back: one layout per edit, not two.
 * A browser without Range geometry (or a test DOM) falls back to collapsing and reading
 * `scrollHeight`.
 */
function contentLines(el: HTMLElement): number {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  if (typeof range.getBoundingClientRect === "function") {
    const box = range.getBoundingClientRect();
    // Glyph boxes are a little shorter or taller than the 20px line; whole lines round.
    if (box.height > 0) return Math.round(box.height / inputLine);
  }
  el.style.height = "auto";
  return Math.ceil(el.scrollHeight / inputLine);
}

/**
 * Fit the input to its text in whole lines, before paint: two 20px lines at rest, growing a line
 * at a time up to seven visual lines or 40% of the window, then scrolling. Heights are always whole pixels, and the
 * text always stays above the +/approvals/send action row, including when empty. Input grows
 * upward and leaves room for attached panels; the full draft stays editable through scrolling.
 * Runs on every edit and when the composer's width changes (a panel opening rewraps the text).
 */
export function useAutosize(
  ref: RefObject<HTMLDivElement | null>,
  text: string,
  width: number,
  /** Lines held while empty or short: two, or one in the pill composer. */
  minLines: number = inputMinLines,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    // Not laid out yet (hidden, detached): nothing to measure.
    if (!el || width <= 0) return;
    const measure = () => {
      // Reserve the same minimum for empty and short drafts.
      const lines = text.trim() ? Math.max(minLines, contentLines(el)) : minLines;
      const column = el.closest<HTMLElement>("[data-thread-column]");
      const dock = el.closest<HTMLElement>("[data-composer-dock]");
      const available =
        column && dock
          ? column.clientHeight - (dock.offsetHeight - el.offsetHeight) - 16
          : innerHeight;
      const room = Math.max(1, Math.floor(Math.min(innerHeight * 0.4, available) / inputLine));
      const height = `${Math.min(lines, room, 7) * inputLine}px`;
      if (el.style.height !== height) el.style.height = height;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref, text, width, minLines]);
}
