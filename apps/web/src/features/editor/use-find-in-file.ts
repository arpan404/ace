import type { EditorDocument, Position, Range } from "@ace/editor";
import { useCallback, useState } from "react";
import { useFindResults, type FindResults } from "./use-find.ts";

/*
 * Find in the open document: the bar's fields, the core's matches, and stepping through them
 * (which selects the match and brings it into view). Matches come from `EditorDocument.find`
 * through the debounced hook; this file only decides which one is current.
 */

export interface FindInFile {
  open: boolean;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  index: number;
  matches: FindResults["matches"];
  status: FindResults["status"];
  openFind(): void;
  close(): void;
  setQuery(query: string): void;
  toggle(option: "regex" | "caseSensitive" | "wholeWord"): void;
  step(delta: 1 | -1): void;
}

export function useFindInFile(options: {
  doc: EditorDocument | undefined;
  version: number;
  /** Selects a match as the editor's single selection. */
  select(range: Range): void;
  reveal(position: Position): void;
  /** Gives the keyboard back to the document after the bar closes. */
  focusEditor(): void;
}): FindInFile {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const { doc, version, select, reveal, focusEditor } = options;

  const results = useFindResults(doc, version, {
    active: open,
    query,
    regex,
    caseSensitive,
    wholeWord,
  });
  const index = results.matches.length ? Math.min(matchIndex, results.matches.length - 1) : 0;

  const openFind = useCallback(() => {
    if (!open && doc) {
      // Opening on a word starts the search with it, as every other editor does.
      const selection = doc.selections()[doc.primarySelection()];
      if (selection && selection.anchor.line === selection.head.line) {
        const text = doc.line(selection.anchor.line);
        const start = Math.min(selection.anchor.column, selection.head.column);
        const end = Math.max(selection.anchor.column, selection.head.column);
        if (end > start && end - start <= 200) setQueryState(text.slice(start, end));
      }
    }
    setOpen(true);
  }, [open, doc]);

  const close = useCallback(() => {
    setOpen(false);
    focusEditor();
  }, [focusEditor]);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setMatchIndex(0);
  }, []);

  const toggle = useCallback((option: "regex" | "caseSensitive" | "wholeWord") => {
    if (option === "regex") setRegex((value) => !value);
    if (option === "caseSensitive") setCaseSensitive((value) => !value);
    if (option === "wholeWord") setWholeWord((value) => !value);
    setMatchIndex(0);
  }, []);

  const step = useCallback(
    (delta: 1 | -1) => {
      const count = results.matches.length;
      if (!count) return;
      const next = (((index + delta) % count) + count) % count;
      setMatchIndex(next);
      const range = results.matches[next];
      if (!range) return;
      select(range);
      reveal(range.start);
    },
    [results.matches, index, select, reveal],
  );

  return {
    open,
    query,
    regex,
    caseSensitive,
    wholeWord,
    index,
    matches: results.matches,
    status: results.status,
    openFind,
    close,
    setQuery,
    toggle,
    step,
  };
}
