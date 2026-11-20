import type { Position, TextReplacement } from "@ace/editor";
import { codeExcerpt, codeExcerptLimit } from "@ace/ui-core";

/*
 * Keeping an annotation on its code. Through an edit the range is carried by the ranges the
 * edit replaced, in work proportional to the edit; through a whole-text replacement (the file
 * changed on disk, an agent rewrote it) it is found again by its unchanged lines or by its exact
 * text, once. A range whose code is gone becomes outdated where it was; it is never moved onto
 * other code. Pure.
 */

export interface Span {
  start: Position;
  end: Position;
}

/** Where a range is now, and whether its code is gone. */
export interface Anchored extends Span {
  outdated: boolean;
}

const compare = (a: Position, b: Position) => a.line - b.line || a.column - b.column;

/** `at` after the edits before it, when no edit touched it: shifted by the last one's growth. */
function shifted(at: Position, previous: TextReplacement | undefined): Position {
  if (!previous) return at;
  if (at.line === previous.end.line)
    return {
      line: previous.postEnd.line,
      column: at.column + (previous.postEnd.column - previous.end.column),
    };
  return { line: at.line + (previous.postEnd.line - previous.end.line), column: at.column };
}

/**
 * A range's edge through one transaction's replaced ranges (document order, old coordinates).
 * Text typed or pasted on the range's own edge joins it; an edge inside replaced text moves to
 * that text's far side, so the range only shrinks around what is left of its own code.
 */
function mapEdge(
  at: Position,
  replacements: readonly TextReplacement[],
  edge: "start" | "end",
): Position {
  let previous: TextReplacement | undefined;
  for (const change of replacements) {
    const fromStart = compare(at, change.start);
    if (fromStart < 0) break;
    const fromEnd = compare(at, change.end);
    if (fromEnd > 0) {
      previous = change;
      continue;
    }
    const postStart = shifted(change.start, previous);
    if (edge === "start") return fromStart === 0 ? postStart : change.postEnd;
    return fromEnd === 0 ? change.postEnd : postStart;
  }
  return shifted(at, previous);
}

/** A range through an edit; its code is gone when nothing of it is left. */
export function mapSpan(span: Span, replacements: readonly TextReplacement[]): Anchored {
  const start = mapEdge(span.start, replacements, "start");
  const end = mapEdge(span.end, replacements, "end");
  const had = compare(span.start, span.end) < 0;
  if (had && compare(start, end) >= 0) return { start, end: start, outdated: true };
  return { start, end, outdated: false };
}

/** Whether any replaced range overlaps or touches the span, so its text may have changed. */
export function touches(span: Span, replacements: readonly TextReplacement[]): boolean {
  return replacements.some(
    (change) => compare(change.start, span.end) <= 0 && compare(change.end, span.start) >= 0,
  );
}

/** The text between two positions, read no further than `limit` characters past its start. */
export function textOf(
  line: (index: number) => string,
  span: Span,
  limit = Number.POSITIVE_INFINITY,
): string {
  const { start, end } = span;
  if (start.line === end.line) return line(start.line).slice(start.column, end.column);
  const parts = [line(start.line).slice(start.column)];
  let length = parts[0]?.length ?? 0;
  for (let at = start.line + 1; at < end.line && length <= limit; at++) {
    const text = line(at);
    parts.push(text);
    length += text.length + 1;
  }
  if (length <= limit) parts.push(line(end.line).slice(0, end.column));
  return parts.join("\n");
}

/** The excerpt of `span`: a range of a whole large file reads only what the excerpt keeps. */
export function excerptOf(line: (index: number) => string, span: Span) {
  return codeExcerpt(textOf(line, span, codeExcerptLimit));
}

function positionAt(text: string, offset: number): Position {
  let line = 0;
  let from = 0;
  for (let next = text.indexOf("\n", from); next >= 0 && next < offset;) {
    line += 1;
    from = next + 1;
    next = text.indexOf("\n", from);
  }
  return { line, column: offset - from };
}

/** The one place `excerpt` occurs in `text`; undefined when it is absent or there twice. */
export function findOnce(text: string, excerpt: string): Span | undefined {
  if (!excerpt.trim()) return undefined;
  const at = text.indexOf(excerpt);
  if (at < 0 || text.indexOf(excerpt, at + 1) >= 0) return undefined;
  return { start: positionAt(text, at), end: positionAt(text, at + excerpt.length) };
}

/** The last line a span uses: a span ending at a line's start stops on the line before. */
const lastLineOf = (span: Span) =>
  span.end.column === 0 && span.end.line > span.start.line ? span.end.line - 1 : span.end.line;

/** What stands on a range's own lines around it: before its start and after its end. */
const besideOf = (lines: readonly string[], span: Span) => ({
  before: (lines[span.start.line] ?? "").slice(0, span.start.column),
  after: (lines[span.end.line] ?? "").slice(span.end.column),
});

/**
 * Where a rewritten range's code went: its exact text, found once in the new text, that was
 * also the only copy in the old text (so it is this range's code, not a look-alike) and that
 * stands between the same text on its own lines as it did.
 */
function refind(
  span: Span,
  excerpt: string,
  before: readonly string[],
  after: readonly string[],
  afterText: string,
): Span | undefined {
  const found = findOnce(afterText, excerpt);
  if (!found || !findOnce(before.join("\n"), excerpt)) return undefined;
  const was = besideOf(before, span);
  const now = besideOf(after, found);
  return was.before === now.before && was.after === now.after ? found : undefined;
}

/**
 * A range after its file's whole text changed from `before` to `after`: kept when the change is
 * all below it, shifted when all above it, and otherwise found again by its exact text when that
 * is the one copy in both texts, between the same text on its lines. Anything else is outdated
 * at the nearest line it had.
 */
export function reanchor(
  span: Span,
  excerpt: { text: string; cut?: boolean | undefined },
  before: readonly string[],
  after: readonly string[],
  afterText: string,
): Anchored {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  if (lastLineOf(span) < prefix) return { ...span, outdated: false };
  if (span.start.line >= before.length - suffix) {
    const grown = after.length - before.length;
    return {
      start: { line: span.start.line + grown, column: span.start.column },
      end: { line: span.end.line + grown, column: span.end.column },
      outdated: false,
    };
  }
  const found = excerpt.cut ? undefined : refind(span, excerpt.text, before, after, afterText);
  if (found) return { ...found, outdated: false };
  const line = Math.min(span.start.line, Math.max(0, after.length - 1));
  const point = { line, column: Math.min(span.start.column, after[line]?.length ?? 0) };
  return { start: point, end: point, outdated: true };
}

/**
 * A stored range against the text an editor opened with: kept when its code is still there,
 * found again when it moved, outdated when it is gone.
 */
export function verify(
  span: Span,
  excerpt: { text: string; cut?: boolean | undefined },
  lines: readonly string[],
  text: string,
): Anchored {
  const inRange =
    span.end.line < lines.length || (span.end.line === lines.length && span.end.column === 0);
  const line = (index: number) => lines[index] ?? "";
  const here = inRange ? textOf(line, span) : undefined;
  const matches = excerpt.cut ? here?.startsWith(excerpt.text) : here === excerpt.text;
  if (matches) return { ...span, outdated: false };
  const found = excerpt.cut ? undefined : findOnce(text, excerpt.text);
  if (found) return { ...found, outdated: false };
  const last = Math.min(span.start.line, Math.max(0, lines.length - 1));
  const point = { line: last, column: Math.min(span.start.column, lines[last]?.length ?? 0) };
  return { start: point, end: point, outdated: true };
}
