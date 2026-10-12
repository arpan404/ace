import { useLayoutEffect, type RefObject } from "react";
import { inputLine, inputMinLines } from "./composer-styles.ts";

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
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    // Not laid out yet (hidden, detached): nothing to measure.
    if (!el || width <= 0) return;
    const measure = () => {
      el.style.height = "auto";
      // Reserve the same minimum for empty and short drafts.
      const lines = text.trim()
        ? Math.max(inputMinLines, Math.ceil(el.scrollHeight / inputLine))
        : inputMinLines;
      const column = el.closest<HTMLElement>("[data-thread-column]");
      const dock = el.closest<HTMLElement>("[data-composer-dock]");
      const available =
        column && dock
          ? column.clientHeight - (dock.offsetHeight - el.offsetHeight) - 16
          : innerHeight;
      const room = Math.max(1, Math.floor(Math.min(innerHeight * 0.4, available) / inputLine));
      el.style.height = `${Math.min(lines, room, 7) * inputLine}px`;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref, text, width]);
}
