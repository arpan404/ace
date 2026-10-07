import { useLayoutEffect, type RefObject } from "react";
import { inputLine, inputPadding } from "./composer-styles.ts";

/**
 * Fit the input to its text in whole lines, before paint: one 20px line at rest, growing a line
 * at a time up to 40% of the window, then scrolling. Heights are always whole pixels, and the
 * input only grows upward from the footer, so the text keeps its inset at every line count.
 * Runs on every edit and when the composer's width changes (a panel opening rewraps the text).
 */
export function useAutosize(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  width: number,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    // Not laid out yet (hidden, detached): nothing to measure.
    if (!el || width <= 0) return;
    el.style.height = "auto";
    // An empty input is one line, however long its placeholder.
    const lines = text ? Math.max(1, Math.round((el.scrollHeight - inputPadding) / inputLine)) : 1;
    const room = Math.max(1, Math.floor((innerHeight * 0.4 - inputPadding) / inputLine));
    el.style.height = `${Math.min(lines, room) * inputLine + inputPadding}px`;
  }, [ref, text, width]);
}
