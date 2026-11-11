import { composerLines } from "./composer-lines.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/*
 * How the composer draws its Markdown while it is typed: headings at their size, `**bold**`
 * in bold with its marks dimmed, list markers as bullets, chips where their tokens are. The text
 * itself never changes; this only says which ranges of it are drawn how. Pure.
 */

export type DecorationKind =
  | "h1"
  | "h2"
  | "h3"
  /** The Markdown a style is written with: `## `, `**`. */
  | "mark"
  | "bold"
  /** A bullet item's `-` or `*`, drawn as a bullet. */
  | "bullet"
  /** An ordered item's `1.`. */
  | "number"
  /** The spaces that nest an item. */
  | "indent";

export type DecorationNode =
  | { type: "text"; start: number; end: number }
  /** The chip of `tokens[index]`. */
  | { type: "token"; index: number }
  | {
      type: "span";
      kind: DecorationKind;
      /** A list item's level, 1 at the top. */
      depth?: number | undefined;
      start: number;
      end: number;
      children: DecorationNode[];
    };

interface Span {
  kind: DecorationKind;
  depth?: number | undefined;
  start: number;
  end: number;
}

/**
 * The `**bold**` runs in `[start, end)` of `text`, marks included. A `**` inside a chip is the
 * chip's own text and never opens or closes one.
 */
export function boldSpans(
  text: string,
  start: number,
  end: number,
  tokens: readonly ComposerToken[],
): { start: number; end: number }[] {
  let masked = text.slice(start, end);
  for (const token of tokens) {
    const from = Math.max(token.start, start);
    const to = Math.min(token.end, end);
    if (from < to)
      masked = masked.slice(0, from - start) + "x".repeat(to - from) + masked.slice(to - start);
  }
  const found: { start: number; end: number }[] = [];
  for (const match of masked.matchAll(/\*\*(?=\S)[\s\S]*?\S\*\*/g))
    found.push({ start: start + match.index, end: start + match.index + match[0].length });
  return found;
}

function lineSpans(text: string, tokens: readonly ComposerToken[]): Span[] {
  const spans: Span[] = [];
  for (const line of composerLines(text)) {
    let words = line.start;
    if (line.kind === "heading") {
      spans.push({ kind: `h${line.level}`, start: line.start, end: line.end });
      spans.push({ kind: "mark", start: line.start, end: line.content });
      words = line.content;
    }
    if (line.kind === "item") {
      const marker = line.start + line.indent;
      if (line.indent) spans.push({ kind: "indent", start: line.start, end: marker });
      spans.push({
        kind: line.number === undefined ? "bullet" : "number",
        depth: line.depth,
        start: marker,
        end: marker + line.marker.length,
      });
      words = line.content;
    }
    for (const bold of boldSpans(text, words, line.end, tokens)) {
      spans.push({ kind: "bold", ...bold });
      spans.push({ kind: "mark", start: bold.start, end: bold.start + 2 });
      spans.push({ kind: "mark", start: bold.end - 2, end: bold.end });
    }
  }
  // A style can't cut through a chip.
  const cuts = (at: number) => tokens.some((token) => token.start < at && at < token.end);
  return spans.filter((span) => !cuts(span.start) && !cuts(span.end));
}

/** `[start, end)` as text and chips, the chips at their tokens. */
function leaves(start: number, end: number, tokens: readonly ComposerToken[]): DecorationNode[] {
  const nodes: DecorationNode[] = [];
  let at = start;
  const inside = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.start >= start && token.end <= end)
    .toSorted((a, b) => a.token.start - b.token.start);
  for (const { token, index } of inside) {
    if (token.start < at) continue;
    if (token.start > at) nodes.push({ type: "text", start: at, end: token.start });
    nodes.push({ type: "token", index });
    at = token.end;
  }
  if (end > at) nodes.push({ type: "text", start: at, end });
  return nodes;
}

function nest(
  start: number,
  end: number,
  spans: readonly Span[],
  tokens: readonly ComposerToken[],
): DecorationNode[] {
  const nodes: DecorationNode[] = [];
  let at = start;
  let index = 0;
  while (index < spans.length) {
    const span = spans[index];
    if (!span) break;
    // The spans nested in this one follow it in order.
    let inner = index + 1;
    while (inner < spans.length && (spans[inner]?.end ?? 0) <= span.end) inner++;
    nodes.push(...leaves(at, span.start, tokens));
    nodes.push({
      type: "span",
      kind: span.kind,
      ...(span.depth === undefined ? {} : { depth: span.depth }),
      start: span.start,
      end: span.end,
      children: nest(span.start, span.end, spans.slice(index + 1, inner), tokens),
    });
    at = span.end;
    index = inner;
  }
  nodes.push(...leaves(at, end, tokens));
  return nodes;
}

/** How to draw `text` with `tokens` as its chips, as a tree of styled ranges. */
export function decorateComposerText(
  text: string,
  tokens: readonly ComposerToken[],
): DecorationNode[] {
  const spans = lineSpans(text, tokens).toSorted((a, b) => a.start - b.start || b.end - a.end);
  return nest(0, text.length, spans, tokens);
}

/** Separators of a drawing's signature; none of them can be typed into the composer. */
export const decorationMarks = { open: "\u0001", name: "\u0002", close: "\u0003" } as const;

/**
 * A drawing as one string: its text, its chips' texts and where each style opens and closes.
 * Two drawings with the same signature look the same, so an editor already showing one is left
 * alone. The editor reads the same signature off what it shows.
 */
export function decorationSignature(
  nodes: readonly DecorationNode[],
  text: string,
  tokens: readonly ComposerToken[],
): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return text.slice(node.start, node.end);
      if (node.type === "token") {
        const token = tokens[node.index];
        return token ? chipSignature(text.slice(token.start, token.end)) : "";
      }
      return (
        styleSignature(node.kind, node.depth) +
        decorationSignature(node.children, text, tokens) +
        decorationMarks.close
      );
    })
    .join("");
}

/** A style's opening in a signature. */
export function styleSignature(kind: string, depth: number | undefined): string {
  return `${decorationMarks.open}${kind}${depth ?? ""}${decorationMarks.name}`;
}

/** A chip in a signature. */
export function chipSignature(text: string): string {
  return `${decorationMarks.open}${decorationMarks.name}${text}${decorationMarks.close}`;
}
