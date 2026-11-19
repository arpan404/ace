import type { EditorDocument, Position, Range } from "@ace/editor";
import { useMemo } from "react";
import { useFindInFile, type FindInFile } from "./use-find-in-file.ts";
import { useFindResults } from "./use-find.ts";

/*
 * The editor's find: the bar's own search while it is open, the Files toolbar's query (a
 * read-only tab) when it is closed, and which match is the current one. The view only draws the
 * matches and the bar.
 */

export interface EditorFind {
  finder: FindInFile;
  matches: readonly Range[];
  /** The query highlighted now: the bar's, else the tab's. */
  query: string;
  /** The match the bar or the tab is on, or -1. */
  current: number;
}

export function useEditorFind(options: {
  doc: EditorDocument | undefined;
  version: number;
  /** A find from the Files toolbar: highlight it and reveal its hit. */
  find: { query: string; hit?: { line: number; column: number } | undefined } | undefined;
  select(range: Range): void;
  reveal(position: Position): void;
  focusEditor(): void;
}): EditorFind {
  const { doc, version, find, select, reveal, focusEditor } = options;
  const finder = useFindInFile({ doc, version, select, reveal, focusEditor });
  const external = useFindResults(doc, version, {
    active: !finder.open && !!find?.query,
    query: finder.open ? "" : (find?.query ?? ""),
    caseSensitive: false,
  });
  const matches = finder.open ? finder.matches : external.matches;
  const query = finder.open ? finder.query : (find?.query ?? "");
  const current = useMemo(() => {
    if (finder.open) return finder.index;
    const hit = find?.hit;
    if (!hit) return -1;
    return matches.findIndex(
      (range) => range.start.line === hit.line && range.start.column === hit.column,
    );
  }, [finder.open, finder.index, find?.hit, matches]);
  return { finder, matches, query, current };
}
