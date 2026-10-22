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
/** GitHub logins: letters, digits and single dashes; a reference: a number or title words. */
const queryChars = { mention: /^[\w-]*$/, reference: /^[\w.-]*$/ };

/** Inside a fenced code block: an odd number of fence lines before `at`. */
function inFence(value: string, at: number): boolean {
  let fences = 0;
  for (const line of value.slice(0, at).split("\n").slice(0, -1))
    if (/^\s{0,3}(```|~~~)/.test(line)) fences++;
  return fences % 2 === 1;
}

/** Inside an inline code span on the caret's line: an odd number of backticks before it. */
function inCodeSpan(value: string, lineStart: number, at: number): boolean {
  return (value.slice(lineStart, at).match(/`/g)?.length ?? 0) % 2 === 1;
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
  if (kind === "reference" && /^\s*#*$/.test(before.slice(0, at))) {
    // "#" opening a line is a heading unless a word already follows it ("#12", "#fix").
    if (query === "" || before.slice(0, at).trim() !== "") return undefined;
  }
  const from = lineStart + at;
  if (inFence(value, from) || inCodeSpan(value, lineStart, from)) return undefined;
  return { kind, query, from, to: start };
}

/**
 * Replace the typed trigger word with `text` and a space, leaving the caret after the space. A
 * space already following the caret is reused rather than doubled.
 */
export function completionChange(
  selection: Selection,
  match: CompletionMatch,
  text: string,
): Change {
  const spaced = /^\s/.test(selection.value.slice(match.to, match.to + 1));
  const insert = spaced ? text : `${text} `;
  const caret = match.from + insert.length + (spaced ? 1 : 0);
  return { from: match.from, to: match.to, insert, select: [caret, caret] };
}
