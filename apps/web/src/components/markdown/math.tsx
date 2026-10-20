import { memo, useEffect, useState, type ReactNode } from "react";
import { renderMathCached } from "./math-cache.ts";
import { loadMath, onMathLoaded } from "./math-load.ts";

/*
 * One math span. The first commit reads through the shared cache, rendering
 * synchronously when KaTeX has loaded (warmed at idle or when the parser
 * first saw math): a warm formula commits its math with no source frame. Only
 * a cold cache miss loads KaTeX and commits on arrival.
 *
 * Until KaTeX is there the span shows its source as ordinary prose (display
 * math reserves its height so the swap does not move the page). A failed
 * chunk load is the same state, not an error: the formula waits for the next
 * load that succeeds. TeX KaTeX rejects shows its source, quietly muted, in
 * the prose font: it is prose the agent wrote, never a code span.
 *
 * Rendered output inherits the prose color (KaTeX sets no ink of its own),
 * keeps display math in a scrolling row so wide formulas never push the page,
 * and carries KaTeX's MathML for screen readers. `data-tex-source` holds the
 * original delimited TeX, which copying a selection puts on the clipboard
 * (`math-copy.ts`).
 */

export interface FormulaProps {
  raw: string;
  tex: string;
  display: boolean;
}

/** The source of TeX KaTeX cannot render: prose, muted, never code. */
const invalidClass = "text-muted-foreground";

const displayRow = "my-1 block max-w-full overflow-x-auto overflow-y-hidden";

export const Formula = memo(function Formula(props: FormulaProps): ReactNode {
  // The cached HTML seeds state per instance (never a render-phase cache read:
  // the compiler may memoize one across the fill below). The key the parent
  // sets keeps one instance on one formula, so this never goes stale.
  const [html, setHtml] = useState<string | undefined>(() =>
    renderMathCached(props.tex, props.display),
  );
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (html !== undefined || invalid) return;
    let cancelled = false;
    // KaTeX has registered its renderer: an empty result now means invalid TeX.
    const fill = () => {
      if (cancelled) return;
      const rendered = renderMathCached(props.tex, props.display);
      if (rendered === undefined) setInvalid(true);
      else setHtml(rendered);
    };
    const unsubscribe = onMathLoaded(fill);
    void loadMath().then((ok) => {
      if (ok) fill();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [html, invalid, props.tex, props.display]);
  if (invalid)
    return props.display ? (
      <span className={displayRow}>
        <span className={invalidClass}>{props.raw}</span>
      </span>
    ) : (
      <span className={invalidClass}>{props.raw}</span>
    );
  if (html === undefined)
    return props.display ? (
      <span className={displayRow}>
        <span className="block min-h-[2em]">{props.raw}</span>
      </span>
    ) : (
      <span>{props.raw}</span>
    );
  if (props.display)
    return (
      <span className={displayRow}>
        <span data-tex-source={props.raw} dangerouslySetInnerHTML={{ __html: html }} />
      </span>
    );
  return <span data-tex-source={props.raw} dangerouslySetInnerHTML={{ __html: html }} />;
});
