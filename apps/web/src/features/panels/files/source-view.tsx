// oxlint-disable react/no-array-index-key -- tokens and text runs have no identity; position is it.
import type { LineMark } from "@ace/ui-core";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { tokensFit } from "@/components/markdown/code-lines.ts";
import { CodeTokens } from "@/components/markdown/code-tokens.tsx";
import { useLatestCodeLines } from "@/components/markdown/use-code-lines.ts";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";

import type { FindHit } from "./find-hits.ts";
import { useSettled } from "./use-checkout.ts";
export { findHits, type FindHit } from "./find-hits.ts";

/** A line with each occurrence of `query` marked, the current one stronger. */
function Marked(props: { text: string; query: string; current: number | undefined }) {
  const parts: ReactNode[] = [];
  const lower = props.text.toLowerCase();
  const needle = props.query.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push(props.text.slice(from, at));
    parts.push(
      <mark
        key={at}
        className={cn(
          "rounded-xs bg-foreground/18 text-foreground",
          at === props.current && "bg-ring/55",
        )}
      >
        {props.text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (from < props.text.length) parts.push(props.text.slice(from));
  return parts;
}

/** Bring a line into view, whether the rows are virtual (long files) or all mounted. */
function reveal(box: HTMLElement | null, handle: VirtualRowsHandle | null, index: number) {
  if (handle) return handle.scrollToIndex(index);
  box?.querySelector(`[data-line="${index}"]`)?.scrollIntoView?.({ block: "center" });
}

export const sourceGutter = (lines: number) => Math.max(48, String(lines).length * 8 + 24);

/** The diff view's colours: new text green at the gutter's edge, a removal red above a line. */
const markBar: Record<LineMark, string> = {
  added: "shadow-[inset_-3px_0_0_var(--status-done)]",
  modified: "shadow-[inset_-3px_0_0_var(--status-done)]",
  removed: "shadow-[inset_0_2px_0_var(--status-failed)]",
};
const markWords: Record<LineMark, string> = {
  added: "Added since the last commit",
  modified: "Changed since the last commit",
  removed: "Lines removed above",
};

/**
 * A source file with line numbers: 13px mono on a 22px pitch, numbers right-aligned in their
 * own gutter (left out of a copy), highlighted in the markdown worker and plain until then.
 * Only the lines near the viewport mount, so a 50,000-line file scrolls like a short one.
 * Lines changed since the last commit carry a bar at the gutter's edge.
 */
export const SourceView = memo(function SourceView(props: {
  text: string;
  lang: string | undefined;
  wrap: boolean;
  /** Find-in-file: the text being looked for and the hit to bring into view. */
  find?: { query: string; hit: FindHit | undefined } | undefined;
  /** A line (1-based) to bring into view once. */
  line?: number | undefined;
  label: string;
  /** Uncommitted changes by line (1-based). */
  marks?: ReadonlyMap<number, LineMark> | undefined;
  /**
   * Highlight only once the text has stopped changing for this long (an editor, as you type).
   * Lines whose text still matches keep their colours meanwhile.
   */
  highlightDelay?: number | undefined;
}) {
  const highlightSource = useSettled(props.text, props.highlightDelay ?? 0);
  const highlighted = useLatestCodeLines(
    props.highlightDelay ? highlightSource : props.text,
    props.lang,
  );
  const plain = useMemo(() => props.text.split("\n"), [props.text]);
  // A final newline ends the last line; it doesn't start an empty one.
  const count = plain.length > 1 && plain.at(-1) === "" ? plain.length - 1 : plain.length;
  const indexes = useMemo(() => Array.from({ length: count }, (_, index) => index), [count]);
  const gutter = sourceGutter(count);
  const handle = useRef<VirtualRowsHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const hit = props.find?.hit;
  const hitLine = hit?.line;
  useEffect(() => {
    if (hitLine !== undefined) reveal(box.current, handle.current, hitLine);
  }, [hitLine]);
  useEffect(() => {
    if (props.line && props.line > 0) reveal(box.current, handle.current, props.line - 1);
  }, [props.line]);
  const query = props.find?.query ?? "";
  return (
    <div
      ref={box}
      role="region"
      aria-label={props.label}
      className={cn("min-w-full py-2 font-mono text-ui leading-[22px]", !props.wrap && "w-max")}
    >
      <LongRows
        virtualAbove={400}
        handle={handle}
        items={indexes}
        rowKey={(index) => String(index)}
        estimate={22}
        overscan={12}
        render={(index) => {
          const text = plain[index] ?? "";
          const kept = highlighted?.lines[index];
          // Lines highlighted for an earlier text show plain until their own colours arrive.
          const tokens = kept && tokensFit(kept, text) ? kept : undefined;
          const mark = props.marks?.get(index + 1);
          return (
            <div
              data-line={index}
              className={cn(
                "flex min-h-[22px]",
                hit?.line === index && "bg-foreground/5",
                props.line === index + 1 && "bg-foreground/5",
              )}
            >
              <span
                aria-hidden
                title={mark && markWords[mark]}
                data-mark={mark}
                style={{ width: gutter }}
                className={cn(
                  "sticky left-0 z-[1] shrink-0 bg-background pr-4 text-right text-subtle-foreground tabular-nums select-none",
                  mark && markBar[mark],
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  "min-w-0 pr-6 text-foreground",
                  props.wrap ? "flex-1 break-all whitespace-pre-wrap" : "whitespace-pre",
                )}
              >
                {query ? (
                  <Marked
                    text={text}
                    query={query}
                    current={hit?.line === index ? hit.column : undefined}
                  />
                ) : tokens ? (
                  <CodeTokens tokens={tokens} />
                ) : (
                  text
                )}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
});
