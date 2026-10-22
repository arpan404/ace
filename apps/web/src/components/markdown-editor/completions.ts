import type { Change, Selection } from "./edits.ts";

/** What is being completed at the caret: a person after `@`, or an issue or PR after `#`. */
export interface CompletionMatch {
  kind: "mention" | "reference";
  /** What was typed after the trigger. */
  query: string;
  /** Where the trigger character is. */
  from: number;
  /** The caret: the end of what is replaced. */
  to: number;
}

const triggers = { "@": "mention", "#": "reference" } as const;
/**
 * What may follow the trigger. A login: letters, digits and dashes. A reference: a number
 * (ended by a space), or title words with single spaces between them ("#retry budg").
 */
const queryChars = {
  mention: /^[\w-]*$/,
  reference: /^(?:\d+|[A-Za-z_.-][\w.-]*(?: [\w.-]+)* ?)?$/,
};

const listItem = /^\s*(?:[-*+]|\d+[.)])\s/;
const indented = /^(?: {4}|\t)/;

/**
 * Whether the line `at` is on is code as CommonMark reads it: inside a fence (``` or ~~~, at
 * any indent so fences inside list items count, closed only by a fence of the same character at
 * least as long), or an indented code block (four spaces or a tab after a blank line, outside a
 * list, where indentation continues the item instead).
 */
function inCodeBlock(value: string, at: number): boolean {
  const lines = value.slice(0, at).split("\n");
  const current = lines.pop() ?? "";
  let fence: { char: string; length: number } | undefined;
  let afterBlank = true;
  let inList = false;
  let indentedCode = false;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const closes =
        marker?.[1] &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim();
      if (closes) fence = undefined;
      continue;
    }
    if (marker?.[1]) {
      fence = { char: marker[1][0] ?? "`", length: marker[1].length };
      continue;
    }
    const blank = !line.trim();
    indentedCode = !blank && indented.test(line) && !inList && (afterBlank || indentedCode);
    if (!blank && !indented.test(line)) inList = listItem.test(line);
    afterBlank = blank;
  }
  if (fence) return true;
  return indented.test(current) && !inList && (afterBlank || indentedCode);
}

/**
 * Inside an inline code span on the caret's line: an opening run of backticks (not escaped)
 * with no closing run of the same length before `at`.
 */
function inCodeSpan(value: string, lineStart: number, at: number): boolean {
  const text = value.slice(lineStart, at);
  let open = 0;
  for (const run of text.matchAll(/(\\*)(`+)/g)) {
    const ticks = run[2]?.length ?? 0;
    // An odd number of backslashes escapes the first backtick of the run.
    const escaped = (run[1]?.length ?? 0) % 2 === 1;
    const length = escaped ? ticks - 1 : ticks;
    if (!length) continue;
    if (!open) open = length;
    else if (length === open) open = 0;
  }
  return open > 0;
}

/**
 * The `@` or `#` word the caret ends, if any. The trigger starts a word (line start, after a
 * space or an opening bracket), as GitHub reads mentions; email addresses, `a#b`, code and a
 * selection never complete. `#` after a line's opening hashes is a heading, not a reference.
 */
export function completionAt(selection: Selection): CompletionMatch | undefined {
  const { value, start, end } = selection;
  if (start !== end) return undefined;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const before = value.slice(lineStart, start);
  const at = Math.max(before.lastIndexOf("@"), before.lastIndexOf("#"));
  if (at < 0) return undefined;
  const trigger = before[at];
  if (trigger !== "@" && trigger !== "#") return undefined;
  const kind = triggers[trigger];
  const query = before.slice(at + 1);
  if (query.length > 60 || !queryChars[kind].test(query)) return undefined;
  const previous = at === 0 ? "" : (before[at - 1] ?? "");
  if (previous && !/[\s([{]/.test(previous)) return undefined;
  // `[text](#anchor)` and `[text](@x)` are a link's target, not a reference or a mention.
  if (before.slice(Math.max(0, at - 2), at) === "](") return undefined;
  if (kind === "reference" && /^\s*#*$/.test(before.slice(0, at))) {
    // "#" opening a line is a heading unless a word already follows it ("#12", "#fix").
    if (query === "" || before.slice(0, at).trim() !== "") return undefined;
  }
  const from = lineStart + at;
  if (inCodeBlock(value, from) || inCodeSpan(value, lineStart, from)) return undefined;
  return { kind, query, from, to: start };
}

/**
 * Replace the whole trigger word with `text` and a space, leaving the caret after the space:
 * picked with the caret mid-word (`@mi|ra`), the rest of the word goes too. A space already
 * following the word is reused rather than doubled.
 */
export function completionChange(
  selection: Selection,
  match: CompletionMatch,
  text: string,
): Change {
  const tail = (match.kind === "mention" ? /^[\w-]*/ : /^[\w.-]*/).exec(
    selection.value.slice(match.to),
  );
  const to = match.to + (tail?.[0].length ?? 0);
  const spaced = /^\s/.test(selection.value.slice(to, to + 1));
  const insert = spaced ? text : `${text} `;
  const caret = match.from + insert.length + (spaced ? 1 : 0);
  return { from: match.from, to, insert, select: [caret, caret] };
}
