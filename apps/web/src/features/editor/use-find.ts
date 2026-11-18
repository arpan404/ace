import { isEditorError, type EditorDocument, type Range } from "@ace/editor";
import { useEffect, useState } from "react";
import { findQuery } from "./find-matches.ts";

/** Matches found by the editor core, or why the query could not be run. */
export interface FindResults {
  matches: readonly Range[];
  status: "idle" | "pending" | "ready" | "invalid";
}

/** How long a query waits after the last keystroke before the core searches. */
const findDelay = 80;
const idle: FindResults = { matches: [], status: "idle" };

/**
 * Find-in-file through the document's own Rust core, debounced off the keystroke path. Only the
 * visible range is highlighted by the caller; the ranges here are in document order for cycling.
 * A query key makes a change show as idle until its own answer arrives, so an old result never
 * highlights the new query's lines.
 */
export function useFindResults(
  doc: EditorDocument | undefined,
  version: number,
  options: {
    active: boolean;
    query: string;
    regex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
  },
): FindResults {
  const { active, query, regex = false, caseSensitive = true, wholeWord = false } = options;
  const [result, setResult] = useState<{ key: string; found: FindResults }>();
  const key = `${version}\u0000${query}\u0000${regex}\u0000${caseSensitive}\u0000${wholeWord}`;
  useEffect(() => {
    if (!doc || !active || !query) return;
    const timer = setTimeout(() => {
      try {
        const matches = doc.find(findQuery({ query, regex, caseSensitive, wholeWord }), 10_000);
        setResult({ key, found: { matches, status: "ready" } });
      } catch (error) {
        if (isEditorError(error)) setResult({ key, found: { matches: [], status: "invalid" } });
      }
    }, findDelay);
    return () => clearTimeout(timer);
  }, [doc, active, query, regex, caseSensitive, wholeWord, key]);
  if (!active || !query) return idle;
  return result?.key === key ? result.found : idle;
}
