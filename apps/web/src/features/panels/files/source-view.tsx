// oxlint-disable react/no-array-index-key -- tokens and text runs have no identity; position is it.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { CodeToken } from "@/components/markdown/highlight.ts";
import { tokenTone } from "@/components/markdown/code-block.tsx";
import { useCodeLines } from "@/components/markdown/use-code-lines.ts";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";

/** One find-in-file hit: a line and where in it the text starts. */
export interface FindHit {
  line: number;
  column: number;
}

/** Every place `query` occurs in `text` (case-insensitive), at most `limit`. */
export function findHits(text: string, query: string, limit = 10_000): FindHit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  const lines = text.toLowerCase().split("\n");
  for (let line = 0; line < lines.length && hits.length < limit; line++) {
    const content = lines[line] ?? "";
    for (let at = content.indexOf(needle); at >= 0 && hits.length < limit;) {
      hits.push({ line, column: at });
      at = content.indexOf(needle, at + needle.length);
    }
  }
  return hits;
}

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
          "rounded-xs bg-[color-mix(in_oklab,var(--foreground)_18%,transparent)] text-foreground",
          at === props.current && "bg-[color-mix(in_oklab,var(--ring)_55%,transparent)]",
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

function Tokens(props: { tokens: readonly CodeToken[] }) {
  return props.tokens.map((token, index) => (
    <span key={index} className={tokenTone[token.kind]}>
      {token.text}
    </span>
  ));
}

/**
 * A source file with line numbers: 13px mono on a 22px pitch, numbers right-aligned in their
 * own gutter (left out of a copy), highlighted in the markdown worker and plain until then.
 * Only the lines near the viewport mount, so a 50,000-line file scrolls like a short one.
 */
export function SourceView(props: {
  text: string;
  lang: string | undefined;
  wrap: boolean;
  /** Find-in-file: the text being looked for and the hit to bring into view. */
  find?: { query: string; hit: FindHit | undefined } | undefined;
  /** A line (1-based) to bring into view once. */
  line?: number | undefined;
  label: string;
}) {
  const highlighted = useCodeLines(props.text, props.lang);
  const plain = useMemo(() => props.text.split("\n"), [props.text]);
  // A final newline ends the last line; it doesn't start an empty one.
  const count = plain.length > 1 && plain.at(-1) === "" ? plain.length - 1 : plain.length;
  const indexes = useMemo(() => Array.from({ length: count }, (_, index) => index), [count]);
  const gutter = Math.max(48, String(count).length * 8 + 24);
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
          const tokens = highlighted?.lines[index];
          return (
            <div
              data-line={index}
              className={cn(
                "flex min-h-[22px]",
                hit?.line === index && "bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]",
                props.line === index + 1 &&
                  "bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]",
              )}
            >
              <span
                aria-hidden
                style={{ width: gutter }}
                className="sticky left-0 z-[1] shrink-0 bg-background pr-4 text-right text-subtle-foreground tabular-nums select-none"
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
                  <Tokens tokens={tokens} />
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
}
