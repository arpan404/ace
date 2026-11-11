import { boldSpans } from "./composer-decoration.ts";
import { composerLines } from "./composer-lines.ts";
import {
  mapTextOffset,
  type TextChange,
  type TextEdit,
  type TextSelection,
} from "./composer-text-edits.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/*
 * ⌘B in the composer: `**` around the selection, or off again. Pure.
 */

const unmark = (span: { start: number; end: number }): TextEdit[] => [
  { start: span.start, end: span.start + 2, insert: "" },
  { start: span.end - 2, end: span.end, insert: "" },
];

/** Where the words of a line start: after a heading's or list item's marker. */
function wordsStart(line: ReturnType<typeof composerLines>[number]): number {
  return line.kind === "plain" || line.kind === "code" ? line.start : line.content;
}

/**
 * Bold on or off. A caret inside bold words takes the bold off them; anywhere else it puts down
 * `****` with the caret between, so the next words typed are bold. A selection already bold
 * (inside one bold run) goes back to plain; otherwise each line's selected words are wrapped,
 * any bold run they touch merging into it.
 */
export function toggleBold(
  text: string,
  selection: TextSelection,
  tokens: readonly ComposerToken[] = [],
): TextChange {
  const lines = composerLines(text).filter(
    (line) => line.end >= selection.start && line.start <= selection.end,
  );
  const caret = selection.start === selection.end;
  const edits: TextEdit[] = [];
  let unbolded = false;
  // The selected words, without the spaces around them, as the selection after wrapping.
  let picked: { start: number; end: number } | undefined;
  for (const line of lines) {
    const words = wordsStart(line);
    const spans = boldSpans(text, words, line.end, tokens);
    if (caret) {
      // Right before or after bold words, the next words typed join them.
      const edge = spans.find(
        (span) => span.start === selection.start || span.end === selection.start,
      );
      if (edge) {
        const at = edge.start === selection.start ? edge.start + 2 : edge.end - 2;
        return { steps: [], selection: { start: at, end: at } };
      }
    }
    const from = Math.max(selection.start, words);
    const to = Math.min(selection.end, line.end);
    const around = spans.find(
      (span) =>
        span.start <= from &&
        to <= span.end &&
        (caret ? span.start < from && from < span.end : true),
    );
    if (around && lines.length === 1) {
      edits.push(...unmark(around));
      unbolded = true;
      continue;
    }
    if (caret) continue;
    // Wrap the selected words, not the spaces around them.
    let start = from;
    let end = to;
    while (start < end && /\s/.test(text[start] ?? "")) start++;
    while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
    if (start === end) continue;
    picked = { start: picked?.start ?? start, end };
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue;
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
      edits.push(...unmark(span));
    }
    edits.push({ start, end: start, insert: "**" }, { start: end, end, insert: "**" });
  }
  if (caret && !unbolded) {
    const at = selection.start;
    return {
      steps: [[{ start: at, end: at, insert: "****" }]],
      selection: { start: at + 2, end: at + 2 },
    };
  }
  if (!edits.length) return { steps: [], selection };
  // A caret stays by the same letter; a selection keeps the same words selected.
  const kept = unbolded ? selection : (picked ?? selection);
  const start = mapTextOffset(kept.start, edits, !caret);
  const end = caret ? start : mapTextOffset(kept.end, edits);
  return { steps: [edits], selection: { start, end } };
}
