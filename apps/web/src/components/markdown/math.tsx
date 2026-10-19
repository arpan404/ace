import { memo, useEffect, useState, type ReactNode } from "react";
import { renderMathCached } from "./math-cache.ts";

/*
 * One math span. The first commit reads through the shared cache, rendering
 * synchronously when KaTeX has loaded (warmed at idle or when the parser
 * first saw math): a warm formula commits its math with no source frame. Only
 * a cold cache miss loads KaTeX and commits on arrival. While loading, or when
 * TeX is invalid, the span shows its source: plain text while loading (display
 * math reserves its height so the swap does not move the page), subdued
 * monospace on failure. The parent keys each instance to one formula, so a
 * settled formula never re-renders on later deltas.
 *
 * Rendered output inherits the prose color (KaTeX sets no ink of its own),
 * centers display math in a scrolling row so wide formulas never push the
 * page, and keeps TeX in its MathML annotation so copying a formula copies
 * its source.
 */

let pending: Promise<unknown> | undefined;
const loadKatex = () => (pending ??= import("./math-katex.ts"));

/** A muted copy of the source, for TeX KaTeX cannot render. */
const fallbackClass = "font-mono text-sm text-muted-foreground";

export interface FormulaProps {
  raw: string;
  tex: string;
  display: boolean;
}

export const Formula = memo(function Formula(props: FormulaProps): ReactNode {
  // The cached HTML seeds state per instance (never a render-phase cache read:
  // the compiler may memoize one across the fill below). The key below keeps
  // one instance on one formula, so this never goes stale.
  const [html, setHtml] = useState<string | undefined>(() =>
    renderMathCached(props.tex, props.display),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (html !== undefined) return;
    let cancelled = false;
    loadKatex().then(
      () => {
        if (cancelled) return;
        // The chunk's evaluation registered the renderer; this hits the cache
        // or renders synchronously into it.
        const rendered = renderMathCached(props.tex, props.display);
        if (rendered === undefined) setFailed(true);
        else setHtml(rendered);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [html, props.tex, props.display]);
  if (failed) return <code className={fallbackClass}>{props.raw}</code>;
  if (html === undefined)
    return props.display ? (
      <span className="my-1 block max-w-full overflow-x-auto">
        <span className="block min-h-[2em]">{props.raw}</span>
      </span>
    ) : (
      <span>{props.raw}</span>
    );
  if (props.display)
    return (
      <span className="my-1 block max-w-full overflow-x-auto">
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </span>
    );
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
});
