import type { Applied, EditorDocument, Position, Range, TextReplacement } from "@ace/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { comparePositions, ordered } from "./cursor.ts";
import { findQuery } from "./find-matches.ts";
import { mapAnchor } from "./use-anchor.ts";
import { useFindResults, type FindResults } from "./use-find.ts";

/*
 * Find and replace in the open document: the bar's fields, the core's matches, and stepping
 * through them (which selects the match and brings it into view). Matches come from the core
 * through the debounced hook; replacing goes through the core too, so Replace All is one undo
 * step. This file only decides which match is current and what the bar asks for.
 */

export type FindOption = "regex" | "caseSensitive" | "wholeWord" | "inSelection";

export interface FindInFile {
  open: boolean;
  /** The replace row is showing under the find row. */
  replacing: boolean;
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** The ranges find is limited to, or undefined for the whole file. */
  scope: readonly Range[] | undefined;
  /** The current match, or -1 before the person has stepped onto one. */
  index: number;
  matches: FindResults["matches"];
  status: FindResults["status"];
  openFind(mode?: "find" | "replace"): void;
  close(): void;
  setQuery(query: string): void;
  setReplacement(replacement: string): void;
  toggle(option: FindOption): void;
  toggleReplace(): void;
  step(delta: 1 | -1): void;
  /** Cmd+G: open the bar if it is closed and go to the next or previous match. */
  findAgain(delta: 1 | -1): void;
  replaceOne(): void;
  replaceAll(): void;
  /** Carries the find-in-selection scope through an edit. */
  mapScope(replacements: readonly TextReplacement[]): void;
}

/** The first match at or after `position`, wrapping to the first; -1 when there are none. */
export function matchFrom(matches: readonly Range[], position: Position): number {
  if (!matches.length) return -1;
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const range = matches[middle];
    if (range && comparePositions(range.start, position) < 0) low = middle + 1;
    else high = middle;
  }
  return low < matches.length ? low : 0;
}

/**
 * The match a step lands on from `index`. With none yet (-1) it starts from the selection: the
 * first match after its end, or the last one before its start.
 */
export function stepIndex(
  matches: readonly Range[],
  index: number,
  delta: 1 | -1,
  selection: Range,
): number {
  const count = matches.length;
  if (!count) return -1;
  if (index < 0 || index >= count) {
    if (delta === 1) return matchFrom(matches, selection.end);
    return (matchFrom(matches, selection.start) - 1 + count) % count;
  }
  return (((index + delta) % count) + count) % count;
}

export function useFindInFile(options: {
  doc: EditorDocument | undefined;
  version: number;
  /** Selects a match as the editor's single selection. */
  select(range: Range): void;
  reveal(position: Position): void;
  /** Applies a command to the document, as typing does. */
  edit(run: (doc: EditorDocument) => Applied | undefined): boolean;
  /** Gives the keyboard back to the document after the bar closes. */
  focusEditor(): void;
}): FindInFile {
  const [open, setOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [query, setQueryState] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [scope, setScope] = useState<readonly Range[]>();
  const [matchIndex, setMatchIndex] = useState(-1);
  /**
   * What happens once the next results arrive: a step (Cmd+G that opened the bar, or after
   * Replace), or a seek to the first match from the caret (a query just typed, as VS Code does).
   */
  const pending = useRef<1 | -1 | "seek" | undefined>(undefined);
  const { doc, version, select, reveal, edit, focusEditor } = options;

  const results = useFindResults(doc, version, {
    active: open,
    query,
    regex,
    caseSensitive,
    wholeWord,
    within: scope,
  });
  const index = matchIndex < results.matches.length ? matchIndex : -1;

  const selectionRange = useCallback((): Range => {
    const selection = doc?.selections()[doc.primarySelection()];
    const origin = { line: 0, column: 0 };
    return selection ? ordered(selection) : { start: origin, end: origin };
  }, [doc]);

  const goTo = useCallback(
    (next: number) => {
      const range = results.matches[next];
      setMatchIndex(next);
      if (!range) return;
      select(range);
      reveal(range.start);
    },
    [results.matches, select, reveal],
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      if (results.status !== "ready") return;
      goTo(stepIndex(results.matches, index, delta, selectionRange()));
    },
    [results.status, results.matches, index, selectionRange, goTo],
  );

  useEffect(() => {
    const next = pending.current;
    if (next === undefined || results.status === "pending") return;
    pending.current = undefined;
    if (results.status !== "ready") return;
    if (next === "seek") {
      // oxlint-disable-next-line react-compiler/set-state-in-effect, react/set-state-in-effect -- the core's results arrive from a timer outside React; the step they wait for runs now.
      if (results.matches.length) goTo(matchFrom(results.matches, selectionRange().start));
    } else step(next);
  }, [results.status, results.matches, step, goTo, selectionRange]);

  const openFind = useCallback(
    (mode: "find" | "replace" = "find") => {
      if (doc) {
        // Opening on a word starts the search with it, as every other editor does.
        const selection = doc.selections()[doc.primarySelection()];
        if (selection && selection.anchor.line === selection.head.line) {
          const text = doc.line(selection.anchor.line);
          const start = Math.min(selection.anchor.column, selection.head.column);
          const end = Math.max(selection.anchor.column, selection.head.column);
          const word = text.slice(start, end);
          if (end > start && end - start <= 200 && word !== query) {
            setQueryState(word);
            setMatchIndex(-1);
            pending.current ??= "seek";
          }
        }
      }
      if (mode === "replace") setReplacing(true);
      setOpen(true);
    },
    [doc, query],
  );

  const close = useCallback(() => {
    setOpen(false);
    setScope(undefined);
    focusEditor();
  }, [focusEditor]);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setMatchIndex(-1);
    pending.current = "seek";
  }, []);

  const toggle = useCallback(
    (option: FindOption) => {
      if (option === "regex") setRegex((value) => !value);
      if (option === "caseSensitive") setCaseSensitive((value) => !value);
      if (option === "wholeWord") setWholeWord((value) => !value);
      if (option === "inSelection")
        setScope((current) => {
          if (current || !doc) return undefined;
          return selectionScope(doc);
        });
      setMatchIndex(-1);
      pending.current = "seek";
    },
    [doc],
  );

  const findAgain = useCallback(
    (delta: 1 | -1) => {
      if (open && results.status === "ready") {
        step(delta);
        return;
      }
      pending.current = delta;
      openFind();
    },
    [open, results.status, step, openFind],
  );

  const request = findQuery({ query, regex, caseSensitive, wholeWord });

  const replaceOne = () => {
    if (results.status !== "ready" || !results.matches.length) return;
    const current = results.matches[index];
    // Replace acts on the match the bar is on; before stepping onto one it first goes there.
    if (!current) {
      step(1);
      return;
    }
    const replaced = edit((target) => {
      const applied = target.replaceMatch(request, current, replacement);
      return applied.spans.length ? applied : undefined;
    });
    if (!replaced) {
      step(1);
      return;
    }
    // The next match is found once the core has searched the new text, from the caret on.
    setMatchIndex(-1);
    pending.current = 1;
  };

  const replaceAll = () => {
    if (results.status !== "ready" || !results.matches.length) return;
    edit((target) => {
      const applied = target.replaceAll(request, replacement, scope ?? []);
      return applied.spans.length ? applied : undefined;
    });
    setMatchIndex(-1);
  };

  const mapScope = useCallback((replacements: readonly TextReplacement[]) => {
    if (!replacements.length) return;
    setScope((current) =>
      current?.map((range) => ({
        start: mapAnchor(range.start, replacements),
        end: mapAnchor(range.end, replacements),
      })),
    );
  }, []);

  return {
    open,
    replacing,
    query,
    replacement,
    regex,
    caseSensitive,
    wholeWord,
    scope,
    index,
    matches: results.matches,
    status: results.status,
    openFind,
    close,
    setQuery,
    setReplacement,
    toggle,
    toggleReplace: () => setReplacing((value) => !value),
    step,
    findAgain,
    replaceOne,
    replaceAll,
    mapScope,
  };
}

/** What find in selection searches: every selection, or the caret's line when none is made. */
function selectionScope(doc: EditorDocument): Range[] {
  const ranges = doc
    .selections()
    .map(ordered)
    .filter(({ start, end }) => comparePositions(start, end) !== 0);
  if (ranges.length) return ranges;
  const selection = doc.selections()[doc.primarySelection()];
  const line = selection?.head.line ?? 0;
  return [{ start: { line, column: 0 }, end: { line, column: doc.line(line).length } }];
}
