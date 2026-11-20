import type { EditorDocument, Range, Selection } from "@ace/editor";
import { useMemo } from "react";
import { guideLevels, wordAtCaret, wordOccurrences } from "./decorations.ts";

/*
 * The decorations for the lines on screen: the bracket pair at the caret (a bounded scan in the
 * core), other occurrences of the caret's word on the visible lines, and indent guide levels.
 * Each is recomputed when the caret, the window or the text changes, and reads only what is
 * visible plus a bounded margin.
 */

export function useDecorations(options: {
  doc: EditorDocument | undefined;
  version: number;
  selections: readonly Selection[];
  primary: number;
  lineAt(line: number): string;
  first: number;
  last: number;
  indentSize: number;
}): { brackets: readonly Range[] | undefined; occurrences: readonly Range[]; guides: number[] } {
  const { doc, version, selections, primary, lineAt, first, last, indentSize } = options;
  const head = selections[primary]?.head;
  const line = head?.line ?? 0;
  const column = head?.column ?? 0;
  const single =
    selections.length === 1 &&
    !!head &&
    selections[0]?.anchor.line === line &&
    selections[0]?.anchor.column === column;

  const hasCaret = head !== undefined;
  const brackets = useMemo(
    () => (doc && hasCaret ? doc.matchingBracket({ line, column }) : undefined),
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- the text version moves the pair without moving the caret.
    [doc, version, line, column, hasCaret],
  );

  const occurrences = useMemo(() => {
    if (!single) return [];
    const word = wordAtCaret(lineAt(line), column);
    if (!word) return [];
    const text = lineAt(line).slice(word.start, word.end);
    return wordOccurrences(lineAt, first, last, text);
  }, [single, lineAt, line, column, first, last]);

  const guides = useMemo(
    () => guideLevels(lineAt, first, last, doc?.lenLines() ?? 0, indentSize),
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- lineAt changes with the text and the window.
    [lineAt, first, last, indentSize, version],
  );

  return { brackets, occurrences, guides };
}
