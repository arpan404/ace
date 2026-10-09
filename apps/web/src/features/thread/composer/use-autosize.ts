import { useLayoutEffect, type RefObject } from "react";
import { inputLine, inputPadding } from "./composer-styles.ts";

/**
 * Fit the input to its text in whole lines, before paint: one 20px line at rest, growing a line
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
      // An empty input is one line, however long its placeholder.
      const lines = text.trim()
        ? Math.max(1, Math.ceil((el.scrollHeight - inputPadding) / inputLine))
        : 1;
      const column = el.closest<HTMLElement>("[data-thread-column]");
      const dock = el.closest<HTMLElement>("[data-composer-dock]");
      const available =
        column && dock
          ? column.clientHeight - (dock.offsetHeight - el.offsetHeight) - 16
          : innerHeight;
      const room = Math.max(
        1,
        Math.floor((Math.min(innerHeight * 0.4, available) - inputPadding) / inputLine),
      );
      el.style.height = `${Math.min(lines, room, 7) * inputLine + inputPadding}px`;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref, text, width]);
}
