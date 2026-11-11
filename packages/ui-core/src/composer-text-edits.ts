import type { ComposerToken } from "./composer-tokens.ts";

/*
 * Edits the composer makes to its own text (a list continued, a number renumbered, bold
 * toggled), as replacements of ranges in the text before the edit. The caret and the chips
 * follow them, so an edit far from a chip never takes it away. Pure.
 */

/** Replace `[start, end)` of the text before the edit with `insert`. */
export interface TextEdit {
  start: number;
  end: number;
  insert: string;
}

/** A selection in the text; `start === end` is a caret. */
export interface TextSelection {
  start: number;
  end: number;
}

/**
 * What a composer transform gives back: its edits, in steps (each step's edits are ranges of
 * the text the step before left), and where the selection goes once they're all made.
 */
export interface TextChange {
  steps: readonly (readonly TextEdit[])[];
  selection: TextSelection;
}

const ordered = (edits: readonly TextEdit[]) =>
  edits.toSorted((a, b) => a.start - b.start || a.end - b.end);

/** The text after `edits`, which must not overlap. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let out = "";
  let at = 0;
  for (const edit of ordered(edits)) {
    out += text.slice(at, edit.start) + edit.insert;
    at = edit.end;
  }
  return out + text.slice(at);
}

/**
 * Where `offset` lands after `edits`. An offset inside a replaced range goes to the end of what
 * replaced it; one exactly at an insertion point stays before it unless `after` is set.
 */
export function mapTextOffset(offset: number, edits: readonly TextEdit[], after = false): number {
  let shift = 0;
  for (const edit of ordered(edits)) {
    const delta = edit.insert.length - (edit.end - edit.start);
    if (edit.end < offset || (edit.end === offset && (edit.start < offset || after)))
      shift += delta;
    else if (edit.start < offset) return edit.start + shift + edit.insert.length;
  }
  return offset + shift;
}

/** Chips after `edits`: one an edit touches goes, the rest move with the text around them. */
export function mapTextTokens(
  tokens: readonly ComposerToken[],
  edits: readonly TextEdit[],
): readonly ComposerToken[] {
  if (!edits.length || !tokens.length) return tokens;
  const sorted = ordered(edits);
  const next = tokens.flatMap((token) => {
    let shift = 0;
    for (const edit of sorted) {
      if (edit.end <= token.start && !(edit.start === edit.end && edit.start === token.start)) {
        shift += edit.insert.length - (edit.end - edit.start);
        continue;
      }
      if (edit.start >= token.end) break;
      // An insertion right at the chip's start goes before it.
      if (edit.start === edit.end && edit.start === token.start) {
        shift += edit.insert.length;
        continue;
      }
      return [];
    }
    return [shift ? { ...token, start: token.start + shift, end: token.end + shift } : token];
  });
  return next.length === tokens.length && next.every((token, index) => token === tokens[index])
    ? tokens
    : next;
}

/** The text and chips after `change`, and the selection it leaves. */
export function applyTextChange(
  text: string,
  tokens: readonly ComposerToken[],
  change: TextChange,
): { text: string; tokens: readonly ComposerToken[]; selection: TextSelection } {
  let next = text;
  let kept = tokens;
  for (const step of change.steps) {
    next = applyTextEdits(next, step);
    kept = mapTextTokens(kept, step);
  }
  return { text: next, tokens: kept, selection: change.selection };
}
