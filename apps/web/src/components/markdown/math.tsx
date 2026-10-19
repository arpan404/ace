import { useEffect, useState, type ReactNode } from "react";

/*
 * One math span. While KaTeX loads, or when TeX is invalid, the span shows its
 * source: plain text while loading, subdued monospace on failure. Rendered
 * output inherits the prose color (KaTeX sets no ink of its own), centers
 * display math in a scrolling row so wide formulas never push the page, and
 * keeps TeX in its MathML annotation so copying a formula copies its source.
 */

let pending: Promise<typeof import("./math-katex.ts")> | undefined;
const loadKatex = () => (pending ??= import("./math-katex.ts"));

/** A muted copy of the source, for TeX KaTeX cannot render. */
const fallbackClass = "font-mono text-[0.9em] text-muted-foreground";

export function Formula(props: { raw: string; tex: string; display: boolean }): ReactNode {
  const [html, setHtml] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadKatex().then(
      (katex) => {
        if (cancelled) return;
        const rendered = katex.renderMath(props.tex, props.display);
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
  }, [props.tex, props.display]);
  if (failed) return <code className={fallbackClass}>{props.raw}</code>;
  if (html === undefined) return <span>{props.raw}</span>;
  if (props.display)
    return (
      <span className="my-1 block max-w-full overflow-x-auto">
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </span>
    );
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
