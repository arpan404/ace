// oxlint-disable react/no-array-index-key -- token and match runs have no identity; position is it.
import { tokensFit } from "@/components/markdown/code-lines.ts";
import { CodeTokens } from "@/components/markdown/code-tokens.tsx";
import type { LineMark } from "@ace/ui-core";
import { memo } from "react";
import { cn } from "@/lib/cn.ts";
import type { MatchSegment } from "./find-matches.ts";
import { lineHeight } from "./geometry.ts";
import type { Token } from "./highlighter.ts";

/** Lines longer than this skip tokenization and are drawn as plain, clipped text. */
export const longLine = 10_000;
const clipped = 20_000;

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

function marked(text: string, matches: readonly MatchSegment[]) {
  const parts = [];
  let from = 0;
  for (const [index, match] of matches.entries()) {
    const end = Math.min(match.end, text.length);
    const start = Math.min(match.start, end);
    if (start > from) parts.push(text.slice(from, start));
    if (end > start)
      parts.push(
        <mark
          key={`${index}-${start}`}
          data-find-hit={match.current ? "current" : "match"}
          className={cn(
            "rounded-xs bg-foreground/18 text-foreground",
            match.current && "bg-ring/55",
          )}
        >
          {text.slice(start, end)}
        </mark>,
      );
    from = Math.max(from, end);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * One editor line: its number and diff mark in the sticky gutter, then its text coloured by
 * the highlighter, with find matches drawn from the line's own segments. Long lines stay plain
 * so a generated file cannot hand the DOM a megabyte-wide span.
 */
export const EditorLine = memo(function EditorLine(props: {
  index: number;
  text: string;
  tokens: readonly Token[] | undefined;
  gutter: number;
  top: number;
  mark: LineMark | undefined;
  current: boolean;
  matches: readonly MatchSegment[] | undefined;
  query: string;
}) {
  const long = props.text.length > longLine;
  const text =
    long && props.text.length > clipped ? `${props.text.slice(0, clipped)}…` : props.text;
  const kept =
    props.tokens && !long && tokensFit(props.tokens, props.text) ? props.tokens : undefined;
  return (
    <div
      data-line={props.index}
      data-long-line={long || undefined}
      className={cn(
        "absolute left-0 flex w-max min-w-full font-mono text-ui leading-[22px]",
        props.current && "bg-foreground/5",
      )}
      style={{ top: props.top, height: lineHeight }}
    >
      <span
        aria-hidden
        title={props.mark && markWords[props.mark]}
        data-mark={props.mark}
        style={{ width: props.gutter }}
        className={cn(
          "sticky left-0 z-[1] shrink-0 bg-background pr-4 text-right text-subtle-foreground tabular-nums select-none",
          props.current && "text-foreground",
          props.mark && markBar[props.mark],
        )}
      >
        {props.index + 1}
      </span>
      <span className="min-w-0 pr-6 whitespace-pre text-foreground">
        {props.query && props.matches?.length ? (
          marked(text, props.matches)
        ) : kept ? (
          <CodeTokens tokens={kept} />
        ) : (
          text
        )}
      </span>
    </div>
  );
});
