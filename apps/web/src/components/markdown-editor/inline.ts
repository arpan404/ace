import { selectedLines, type Change, type Selection } from "./edits.ts";

/** Inline marks the toolbar wraps a selection in. */
export type InlineMark = "bold" | "italic" | "code";
const markers: Record<InlineMark, string> = { bold: "**", italic: "_", code: "`" };

/**
 * Wrap the selection in `mark`, or unwrap it when it already carries the mark (inside or just
 * around the selection). Spaces at the selection's edges stay outside the marks, since
 * `** word**` is not bold. With nothing selected the caret lands between the marks.
 */
export function toggleInline(selection: Selection, mark: InlineMark): Change {
  const { value } = selection;
  if (mark === "code" && value.slice(selection.start, selection.end).includes("\n"))
    return codeBlock(selection);
  const marker = markers[mark];
  const size = marker.length;
  let { start, end } = selection;
  while (start < end && /\s/.test(value[start] ?? "")) start++;
  while (end > start && /\s/.test(value[end - 1] ?? "")) end--;
  const inner = value.slice(start, end);
  if (inner.length >= size * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const text = inner.slice(size, -size);
    return { from: start, to: end, insert: text, select: [start, start + text.length] };
  }
  if (value.slice(start - size, start) === marker && value.slice(end, end + size) === marker)
    return {
      from: start - size,
      to: end + size,
      insert: inner,
      select: [start - size, end - size],
    };
  return {
    from: start,
    to: end,
    insert: marker + inner + marker,
    select: [start + size, end + size],
  };
}

/** A multi-line selection as code becomes a fenced block on lines of its own. */
function codeBlock(selection: Selection): Change {
  const { from, to } = selectedLines(selection);
  const code = selection.value.slice(from, to);
  const fenced = /^```[^\n]*\n[\s\S]*\n```$/.test(code);
  if (fenced) {
    const text = code.slice(code.indexOf("\n") + 1, -4);
    return { from, to, insert: text, select: [from, from + text.length] };
  }
  const insert = "```\n" + code + "\n```";
  return { from, to, insert, select: [from + 4, from + 4 + code.length] };
}

const url = /^https?:\/\/\S+$/;

/** Whether `text` is one web address and nothing else. */
export function isUrl(text: string): boolean {
  return url.test(text.trim());
}

/**
 * A link around the selection: `[text](url)` with "url" selected to type over; a selected
 * address goes in the parentheses, with the caret in the brackets for its words.
 */
export function insertLink(selection: Selection): Change {
  const { start, end } = selection;
  const text = selection.value.slice(start, end);
  if (isUrl(text)) {
    const address = text.trim();
    return { from: start, to: end, insert: `[](${address})`, select: [start + 1, start + 1] };
  }
  const insert = `[${text}](url)`;
  const at = start + text.length + 3;
  return { from: start, to: end, insert, select: text ? [at, at + 3] : [start + 1, start + 1] };
}

/**
 * Pasting one web address over selected words links them, as `[words](address)`, with the
 * caret after it. Anything else pastes as usual (`undefined`).
 */
export function linkOnPaste(selection: Selection, pasted: string): Change | undefined {
  const { start, end, value } = selection;
  const text = value.slice(start, end);
  if (start === end || !isUrl(pasted) || isUrl(text) || text.includes("\n")) return undefined;
  const insert = `[${text}](${pasted.trim()})`;
  return { from: start, to: end, insert, select: [start + insert.length, start + insert.length] };
}
