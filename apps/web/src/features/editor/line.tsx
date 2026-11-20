// oxlint-disable react/no-array-index-key -- token and match runs have no identity; position is it.
import { tokensFit } from "@/components/markdown/code-lines.ts";
import { CodeTokens } from "@/components/markdown/code-tokens.tsx";
import type { LineMark } from "@ace/ui-core";
import { memo } from "react";
import { cn } from "@/lib/cn.ts";
import type { MatchSegment } from "./find-matches.ts";
import { tabSize } from "./geometry.ts";
import type { Token } from "./highlighter.ts";

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

/** One line's tokens restricted to `[start, end)`, so a wrapped row colours only its own text. */
export function sliceTokens(
  tokens: readonly Token[],
  start: number,
  end: number,
): readonly Token[] | undefined {
  const parts: Token[] = [];
  let at = 0;
  for (const token of tokens) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + token.text.length);
    if (to > from) parts.push({ ...token, text: token.text.slice(from - at, to - at) });
    at += token.text.length;
  }
  return parts.length ? parts : undefined;
}

/**
 * One visual row of the editor: the sticky gutter with its number (the line's first row only)
 * and diff mark, then the row's text coloured by the highlighter, with find matches drawn from
 * the row's own segments. A line too long to colour stays plain; unwrapped, it is clipped so a
 * generated file cannot hand the DOM a megabyte-wide span.
 */
export const EditorLine = memo(function EditorLine(props: {
  /** The logical line this row belongs to. */
  line: number;
  /** The row's index in the document's visual rows, its identity in the DOM. */
  row: number;
  text: string;
  /** The gutter's number on the line's first row; undefined on the rows below it. */
  number: number | undefined;
  /** Pixels a continuation row indents its text by. */
  indent: number;
  tokens: readonly Token[] | undefined;
  gutter: number;
  top: number;
  /** The row's height; the font and its size come from the editor's frame. */
  lineHeight: number;
  mark: LineMark | undefined;
  /** A press on the mark shows the change: the bar says so to the pointer. */
  markAction?: boolean;
  current: boolean;
  matches: readonly MatchSegment[] | undefined;
  query: string;
  /** The line is past what a highlighter can colour: drawn plain. */
  long: boolean;
  /** Unwrapped: clip the row at the DOM's limit. */
  clip: boolean;
  /** The line starts a region: "open" can fold, "closed" is folded. */
  fold?: "open" | "closed" | undefined;
  /** This is the line's last row, where a folded line shows its ellipsis. */
  lastRow?: boolean;
}) {
  const text =
    props.clip && props.text.length > clipped ? `${props.text.slice(0, clipped)}…` : props.text;
  const kept =
    props.tokens && !props.long && tokensFit(props.tokens, props.text) ? props.tokens : undefined;
  return (
    <div
      data-line={props.number === undefined ? undefined : props.line}
      data-row={props.row}
      data-long-line={props.long || undefined}
      className={cn("absolute left-0 flex w-max min-w-full", props.current && "bg-foreground/5")}
      style={{ top: props.top, height: props.lineHeight, lineHeight: `${props.lineHeight}px` }}
    >
      <span
        aria-hidden
        title={props.mark && markWords[props.mark]}
        data-mark={props.mark}
        data-line-number={props.number}
        style={{ width: props.gutter }}
        className={cn(
          "sticky left-0 z-[1] shrink-0 bg-background pr-4 text-right text-subtle-foreground tabular-nums select-none",
          props.current && "text-foreground",
          props.mark && markBar[props.mark],
          props.mark && props.markAction && "cursor-pointer",
        )}
      >
        {props.number}
        {props.fold ? (
          <span
            data-fold={props.fold}
            className={cn(
              "absolute top-0 right-2 w-3 text-center text-subtle-foreground",
              props.fold === "open" && "opacity-0 group-hover/editor:opacity-100",
            )}
          >
            {props.fold === "closed" ? "›" : "⌄"}
          </span>
        ) : null}
      </span>
      <span
        data-line-text={props.number === undefined ? undefined : props.line}
        data-row-text={props.row}
        className="min-w-0 pr-6 whitespace-pre text-foreground"
        style={{ tabSize: String(tabSize), paddingLeft: props.indent || undefined }}
      >
        {props.query && props.matches?.length ? (
          marked(text, props.matches)
        ) : kept ? (
          <CodeTokens tokens={kept} />
        ) : (
          text
        )}
        {props.fold === "closed" && props.lastRow !== false ? (
          <span
            data-folded-marker
            className="ml-1 rounded-sm bg-accent px-1 text-subtle-foreground"
          >
            ⋯
          </span>
        ) : null}
      </span>
    </div>
  );
});
