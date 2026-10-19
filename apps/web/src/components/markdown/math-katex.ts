import "katex/dist/katex.min.css";
import { renderToString } from "katex";

/*
 * KaTeX loads only with the first message that holds math: `Formula`
 * dynamically imports this module, so KaTeX (code, CSS and fonts, all bundled
 * locally) lands in its own lazy chunk and never in the main bundle.
 * KaTeX's `renderToString` needs no DOM, so this could also run in the
 * markdown worker; it stays on the main thread to keep the worker's parsing
 * synchronous and to keep agent HTML out of the DOM (only KaTeX's own output
 * is injected, and only with `trust: false` plus the red-text check below).
 */

/**
 * `tex` as HTML, or `undefined` when it is not safe to show rendered: invalid
 * TeX throws and is shown as source instead, and untrusted commands (`\href`,
 * `\url`) render red rather than throwing, so those fall back too. Never a
 * red error box.
 */
export function renderMath(tex: string, displayMode: boolean): string | undefined {
  let html: string;
  try {
    html = renderToString(tex, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: false,
    });
  } catch {
    return undefined;
  }
  if (html.includes("katex-error") || html.includes("#cc0000")) return undefined;
  return html;
}
