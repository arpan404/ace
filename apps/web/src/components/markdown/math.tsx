import { memo, useEffect, useState, type ReactNode } from "react";
import { createMathCache } from "./math-cache.ts";

/*
 * One math span. `html` ships with settled blocks from the markdown worker, so
 * the main thread only inserts it: no KaTeX work on arrival. Otherwise the
 * first commit reads the shared cache (a remount or a repeated formula shows
 * with zero KaTeX work and zero waiting); only a cache miss loads KaTeX
 * (warmed at idle or when the parser first saw math), renders into the cache
 * and commits. While loading, or when TeX is invalid, the span shows its
 * source: plain text while loading (display math reserves its height so the
 * swap does not move the page), subdued monospace on failure. The parent keys
 * each instance by its source, so one instance never changes formula and is
 * memoized on (tex, display, html): later deltas to the message never
 * re-render a settled formula.
 *
 * Rendered output inherits the prose color (KaTeX sets no ink of its own),
 * centers display math in a scrolling row so wide formulas never push the
 * page, and keeps TeX in its MathML annotation so copying a formula copies
 * its source.
 */

const cache = createMathCache();

let pending: Promise<typeof import("./math-katex.ts")> | undefined;
const loadKatex = () => (pending ??= import("./math-katex.ts"));

/** A muted copy of the source, for TeX KaTeX cannot render. */
const fallbackClass = "font-mono text-sm text-muted-foreground";

export interface FormulaProps {
  raw: string;
  tex: string;
  display: boolean;
  html?: string | undefined;
}

export const Formula = memo(function Formula(props: FormulaProps): ReactNode {
  // The cached HTML seeds state per instance (never a render-phase cache read:
  // the compiler may memoize one across the fill below). The key below keeps
  // one instance on one formula, so this never goes stale.
  const [html, setHtml] = useState<string | undefined>(
    () => props.html ?? cache.get(props.display, props.tex),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (html !== undefined) return;
    let cancelled = false;
    loadKatex().then(
      (katex) => {
        if (cancelled) return;
        const rendered = katex.renderMath(props.tex, props.display);
        if (rendered === undefined) setFailed(true);
        else {
          cache.set(props.display, props.tex, rendered);
          setHtml(rendered);
        }
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
