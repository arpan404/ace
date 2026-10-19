import "katex/dist/katex.min.css";
import { renderToString } from "katex";
import { renderTex } from "./math-render.ts";

/*
 * KaTeX on the main thread: loads only with the first message that holds math
 * (`Formula` dynamically imports this module), landing in its own lazy chunk.
 * Pure rendering; the caller (`math.tsx`) caches per (display flag, TeX) across
 * every message. Only KaTeX's own HTML is ever injected, and only with the
 * safety settings in `math-render.ts`.
 */

/** `tex` as HTML, or `undefined` when it is not safe to show rendered. */
export function renderMath(tex: string, displayMode: boolean): string | undefined {
  return renderTex(renderToString, tex, displayMode);
}
