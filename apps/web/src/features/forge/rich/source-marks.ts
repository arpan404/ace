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
 * Where `raw` (a token's source) sits in `source` between `from` and `to`: exactly, or, for a
 * token the lexer re-indented (inside a list item or quote), by its first line.
 */
function locate(source: string, raw: string, from: number, to: number) {
  const exact = source.indexOf(raw, from);
  if (raw && exact >= 0 && exact + raw.length <= to)
    return { start: exact, end: exact + raw.length, exact: true };
  const line = raw
    .split("\n")
    .find((part) => part.trim())
    ?.trim();
  if (!line) return undefined;
  const start = source.indexOf(line, from);
  return start >= 0 && start < to ? { start, end: to, exact: false } : undefined;
}

/** Each task box the tokens draw, by its checkbox token, placed in `source`. */
export function taskMarks(source: string, tokens: readonly Token[]): Map<Token, TaskMark> {
  const marks = new Map<Token, TaskMark>();
  const visit = (list: readonly Token[], from: number, to: number) => {
    let cursor = from;
    for (const token of list) {
      if (token.type === "checkbox") continue;
      const region = locate(source, token.raw, cursor, to);
      if (!region) continue;
      cursor = region.exact ? region.end : region.start + 1;
      if (token.type === "list") visit((token as Tokens.List).items, region.start, region.end);
      else if (token.type === "list_item") {
        const item = token as Tokens.ListItem;
        const checkbox = item.tokens.find((child) => child.type === "checkbox");
        const found = checkbox && box.exec(source.slice(region.start, region.start + 256));
        if (checkbox && found?.[1] !== undefined)
          marks.set(checkbox, {
            offset: region.start + found[1].length + 1,
            label: item.text.split("\n")[0]?.trim() || "Task",
          });
        visit(item.tokens, region.start, region.end);
      } else if ("tokens" in token && Array.isArray(token.tokens))
        visit(token.tokens, region.start, region.end);
    }
  };
  visit(tokens, 0, source.length);
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
