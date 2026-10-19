import { createMathCache } from "./math-cache.ts";
import { collectUnrenderedMath } from "./math-extension.ts";
import { renderTex } from "./math-render.ts";
import type { MarkdownBlock } from "./blocks.ts";

/*
 * Settled formulas, rendered where the parser already runs. A block settles
 * once, so its formulas render once: the HTML ships with the block and the
 * main thread only inserts it. The worker keeps its own bounded cache, filled
 * the same way as the main thread's, so a repeated formula never pays KaTeX
 * twice. KaTeX loads on the first settled formula, never before.
 */

const cache = createMathCache();
let katex: Promise<typeof import("katex")> | undefined;

/** Render settled formulas in place; returns how many gained HTML. */
export async function renderSettledMath(blocks: readonly MarkdownBlock[]): Promise<number> {
  const spans = blocks.flatMap((block) => collectUnrenderedMath([block.token]));
  if (spans.length === 0) return 0;
  const loaded = await (katex ??= import("katex")).catch(() => undefined);
  if (!loaded) return 0;
  let rendered = 0;
  for (const span of spans) {
    const cached = cache.get(span.display, span.tex);
    if (cached !== undefined) {
      span.html = cached;
      rendered++;
      continue;
    }
    const html = renderTex(loaded.renderToString, span.tex, span.display);
    if (html === undefined) continue;
    cache.set(span.display, span.tex, html);
    span.html = html;
    rendered++;
  }
  return rendered;
}
