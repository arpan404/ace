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
/** The most matches one search returns: the count reads "10000+" past it. */
export const matchLimit = 10_000;
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
    /** Search only inside these ranges (find in selection); undefined searches everything. */
    within?: readonly Range[] | undefined;
  },
): FindResults {
  const { active, query, regex = false, caseSensitive = true, wholeWord = false, within } = options;
  const [result, setResult] = useState<{ key: string; found: FindResults }>();
  const scope = within ? within.map(rangeKey).join(",") : "";
  const key = `${version}\u0000${query}\u0000${regex}\u0000${caseSensitive}\u0000${wholeWord}\u0000${scope}`;
  useEffect(() => {
    if (!doc || !active || !query) return;
    const timer = setTimeout(() => {
      try {
        const request = findQuery({ query, regex, caseSensitive, wholeWord });
        const matches = within
          ? doc.findWithin(request, within, matchLimit)
          : doc.find(request, matchLimit);
        setResult({ key, found: { matches, status: "ready" } });
      } catch (error) {
        // A rejected pattern is the only failure the core reports; anything else is a bug, but
        // it must not take the view down: the bar says the search failed.
        if (!isEditorError(error)) console.warn("find failed", error);
        setResult({ key, found: { matches: [], status: "invalid" } });
      }
    }, findDelay);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- the scope's ranges are in the key.
  }, [doc, active, query, regex, caseSensitive, wholeWord, key]);
  if (!active || !query) return idle;
  return result?.key === key ? result.found : { matches: [], status: "pending" };
}

function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`;
}
