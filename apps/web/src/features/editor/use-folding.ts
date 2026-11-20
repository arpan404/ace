import type { EditorDocument, LineEdit, Selection } from "@ace/editor";
import { useCallback, useLayoutEffect, useState } from "react";
import { FoldSet } from "./fold-set.ts";
import {
  allFolds,
  foldAround,
  foldAt,
  hiddenRanges,
  isFoldStart,
  type FoldRange,
} from "./folding.ts";
import type { WrapIndex } from "./wrap-index.ts";

/*
 * The editor's folds: which regions are closed, the hidden lines they give the row index, and
 * the commands that open and close them. The index hears about a change before React renders
 * it, so no render ever draws rows for a line that has just been folded away. An edit moves the
 * folds and shows the lines of any it opened in work near the edit; only a fold command hands
 * the index every hidden line again.
 */

export interface Folding {
  /** Whether the line heads a closed fold. */
  isFolded(line: number): boolean;
  /** Whether the line starts a region that could fold. */
  isFoldable(line: number): boolean;
  /** Opens a closed fold on the line, or closes the region it starts. */
  toggle(line: number): void;
  /** Cmd+Alt+[: closes the innermost region around each caret. */
  foldAtCarets(): void;
  /** Cmd+Alt+]: opens the folds around each caret. */
  unfoldAtCarets(): void;
  foldAll(): void;
  unfoldAll(): void;
  /** Carries the folds through an applied edit, opening any whose hidden text it changed. */
  mapThrough(spans: readonly LineEdit[]): void;
}

export function useFolding(options: {
  doc: EditorDocument | undefined;
  layout: WrapIndex | undefined;
  indentSize: number;
  /** Moves carets off lines that a fold just hid. */
  select(selections: readonly Selection[]): void;
}): Folding {
  const { doc, layout, indentSize, select } = options;
  // The folds live outside React, so an edit maps them in place; a new version re-renders.
  const [set] = useState(() => new FoldSet());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const lineAt = useCallback((line: number) => doc?.line(line) ?? "", [doc]);
  const lineCount = doc?.lenLines() ?? 0;

  /** Gives the index the new hidden lines, then React the new folds. */
  const commit = useCallback(
    (next: readonly FoldRange[]) => {
      set.replace(next);
      layout?.setHidden(hiddenRanges(next));
      bump();
    },
    [layout, set, bump],
  );

  // A new index (a new document or a remount) starts without hidden lines: give it the folds.
  useLayoutEffect(() => {
    layout?.setHidden(hiddenRanges(set.toArray()));
  }, [layout, set]);

  /** After closing folds, every caret on a hidden line moves to the end of its fold's header. */
  const liftCarets = useCallback(
    (next: readonly FoldRange[]) => {
      if (!doc) return;
      const ranges = hiddenRanges(next);
      const hidden = (line: number) =>
        ranges.some((range) => line >= range.from && line < range.to);
      const header = (line: number) =>
        next
          .filter((fold) => line > fold.start && line <= fold.end)
          .reduce((a, b) => (a.start < b.start ? a : b));
      const selections = doc.selections();
      if (
        !selections.some(
          (selection) => hidden(selection.head.line) || hidden(selection.anchor.line),
        )
      )
        return;
      select(
        selections.map((selection) => {
          if (!hidden(selection.head.line) && !hidden(selection.anchor.line)) return selection;
          const line = hidden(selection.head.line)
            ? header(selection.head.line).start
            : selection.head.line;
          const position = { line, column: doc.line(line).length };
          return { anchor: position, head: position };
        }),
      );
    },
    [doc, select],
  );

  const close = useCallback(
    (added: readonly FoldRange[]) => {
      const fresh = added.filter((fold) => !set.has(fold.start));
      if (!fresh.length) return;
      const next = [...set.toArray(), ...fresh];
      liftCarets(next);
      commit(next);
    },
    [commit, liftCarets, set],
  );

  const isFolded = useCallback(
    (line: number) => set.has(line),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new version is a new answer: the set changed in place.
    [set, version],
  );
  const isFoldable = useCallback(
    (line: number) => isFoldStart(lineAt, lineCount, line, indentSize),
    [lineAt, lineCount, indentSize],
  );

  const toggle = useCallback(
    (line: number) => {
      if (set.has(line)) {
        commit(set.toArray().filter((fold) => fold.start !== line));
        return;
      }
      const range = foldAt(lineAt, lineCount, line, indentSize);
      if (range) close([range]);
    },
    [commit, close, lineAt, lineCount, indentSize, set],
  );

  const caretLines = useCallback(
    () => [...new Set((doc?.selections() ?? []).map((selection) => selection.head.line))],
    [doc],
  );

  const foldAtCarets = useCallback(() => {
    const ranges = caretLines().flatMap((line) => {
      const range = foldAround(lineAt, lineCount, line, indentSize);
      return range ? [range] : [];
    });
    close(ranges);
  }, [caretLines, close, lineAt, lineCount, indentSize]);

  const unfoldAtCarets = useCallback(() => {
    const lines = caretLines();
    const next = set
      .toArray()
      .filter((fold) => !lines.some((line) => line >= fold.start && line <= fold.end));
    if (next.length !== set.size) commit(next);
  }, [caretLines, commit, set]);

  const foldAll = useCallback(() => {
    close(allFolds(lineAt, lineCount, indentSize));
  }, [close, lineAt, lineCount, indentSize]);

  const unfoldAll = useCallback(() => {
    if (set.size) commit([]);
  }, [commit, set]);

  const mapThrough = useCallback(
    (spans: readonly LineEdit[]) => {
      if (!set.size || !spans.length) return;
      // Folds that only moved keep their hidden lines in the index: those travel with the text.
      // A fold the edit opened shows its own lines, and only those.
      for (const range of set.map(spans)) layout?.showLines(range.from, range.to);
      bump();
    },
    [layout, set, bump],
  );

  return {
    isFolded,
    isFoldable,
    toggle,
    foldAtCarets,
    unfoldAtCarets,
    foldAll,
    unfoldAll,
    mapThrough,
  };
}
