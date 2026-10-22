import type { Token, Tokens } from "marked";

/*
 * Where task boxes and footnote definitions sit in the markdown source of PR and issue text
 * (ADR 0096). Boxes are placed by walking the lexer's own tokens through the source, so the box
 * a person ticks is the box the page drew: code, quotes and nested lists can never make a second
 * reading disagree. Ticking rewrites only that box's mark, so the forge's guarded edit changes
 * nothing else in the text.
 */

/** A drawn task box: the offset of the character inside its `[ ]`, and its item's text. */
export interface TaskMark {
  offset: number;
  label: string;
}

const fence = /^ {0,3}(`{3,}|~{3,})/;
const footnote = /^ {0,3}\[\^([^\]\s]{1,64})\]:/;
// A list item's marker (inside any quotes), then its box.
const box = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\]/;

/**
 * `source` with `\r\n` and lone `\r` as `\n`, as the lexer reads it, and where each of its
 * characters sits in the original text.
 */
function normalised(source: string): { text: string; original: number[] } {
  const original: number[] = [];
  let text = "";
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (char === "\r") {
      original.push(at);
      text += "\n";
      if (source[at + 1] === "\n") at++;
    } else {
      original.push(at);
      text += char;
    }
  }
  original.push(source.length);
  return { text, original };
}

/** The offset just past the end of the `count`th line starting at `start` (its newline too). */
function afterLines(text: string, start: number, count: number): number {
  let at = start;
  for (let line = 0; line < count; line++) {
    const newline = text.indexOf("\n", at);
    if (newline < 0) return text.length;
    at = newline + 1;
  }
  return at;
}

/**
 * Where `raw` (a token's source, as the lexer read it) sits in `text` between `from` and `to`:
 * exactly, or, for a token the lexer re-indented or unquoted (inside a list item or quote), from
 * the line holding its first line, over exactly as many lines as it has.
 */
function locate(text: string, raw: string, from: number, to: number) {
  const exact = text.indexOf(raw, from);
  if (raw && exact >= 0 && exact + raw.length <= to)
    return { start: exact, end: exact + raw.length };
  const lines = raw.replace(/\n+$/, "").split("\n");
  const first = lines.find((line) => line.trim())?.trim();
  if (!first) return undefined;
  const found = text.indexOf(first, from);
  if (found < 0 || found >= to) return undefined;
  const lineStart = text.lastIndexOf("\n", found - 1) + 1;
  const skipped = lines.findIndex((line) => line.trim());
  return {
    start: Math.max(from, lineStart),
    end: Math.min(to, afterLines(text, lineStart, lines.length - skipped)),
  };
}

/** An item's first line as words for its box's name: no footnote markers or emphasis marks. */
function labelOf(text: string): string {
  const words = (text.split("\n")[0] ?? "")
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return words || "Task";
}

/** Block tokens that can hold list items. */
const containers = new Set(["list", "list_item", "blockquote"]);

/** An item's box: first among its tokens, or in its first paragraph when the list is loose. */
function checkboxOf(item: Tokens.ListItem): Token | undefined {
  const direct = item.tokens.find((child) => child.type === "checkbox");
  if (direct) return direct;
  const first = item.tokens[0];
  return first && "tokens" in first && Array.isArray(first.tokens)
    ? first.tokens.find((child: Token) => child.type === "checkbox")
    : undefined;
}

/**
 * Each task box the tokens draw, by its checkbox token, placed in `source`. A box is placed only
 * where its item's own line holds it: anything the walk can't place with certainty stays
 * unplaced, and so only shows its state.
 */
export function taskMarks(source: string, tokens: readonly Token[]): Map<Token, TaskMark> {
  const { text, original } = normalised(source);
  const marks = new Map<Token, TaskMark>();
  const visit = (list: readonly Token[], from: number, to: number) => {
    let cursor = from;
    for (const token of list) {
      if (token.type === "checkbox" || token.type === "space") continue;
      const region = locate(text, token.raw, cursor, to);
      if (!region) continue;
      // Past this token, whatever it is: code it holds is never searched again.
      cursor = region.end;
      if (!containers.has(token.type)) continue;
      if (token.type === "list") visit((token as Tokens.List).items, region.start, region.end);
      else if (token.type === "list_item") {
        const item = token as Tokens.ListItem;
        const checkbox = checkboxOf(item);
        const newline = text.indexOf("\n", region.start);
        const line = text.slice(region.start, newline < 0 ? undefined : newline);
        const found = checkbox && box.exec(line);
        // The box's line must read as this item: its marker, the box, then the item's words.
        const words = item.text.split("\n")[0]?.trim() ?? "";
        if (
          checkbox &&
          found?.[1] !== undefined &&
          line.slice(found[0].length).trim().startsWith(words)
        )
          marks.set(checkbox, {
            offset: original[region.start + found[1].length + 1] ?? -1,
            label: labelOf(item.text),
          });
        visit(item.tokens, region.start, region.end);
      } else visit((token as Tokens.Blockquote).tokens, region.start, region.end);
    }
  };
  visit(tokens, 0, text.length);
  return marks;
}

/** `source` with the box at `mark` set to `checked`; undefined if the text there isn't a box. */
export function withTask(source: string, mark: TaskMark, checked: boolean): string | undefined {
  const at = mark.offset;
  if (source[at - 1] !== "[" || source[at + 1] !== "]" || !/[ xX]/.test(source[at] ?? ""))
    return undefined;
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}

/** Footnote labels in the order they are defined, outside fenced code, numbered from 1. */
export function footnoteNumbers(source: string): Map<string, number> {
  const numbers = new Map<string, number>();
  let open: string | undefined;
  for (const line of source.split("\n")) {
    const opener = fence.exec(line)?.[1];
    if (open) {
      if (opener && opener[0] === open[0] && opener.length >= open.length) open = undefined;
      continue;
    }
    if (opener) {
      open = opener;
      continue;
    }
    const label = footnote.exec(line)?.[1];
    if (label !== undefined && !numbers.has(label)) numbers.set(label, numbers.size + 1);
  }
  return numbers;
}
