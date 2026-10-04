/*
 * A search snippet as runs of plain and matched text. The daemon sends plain text with
 * half-open UTF-16 highlight offsets (ADR 0062); offsets may overlap, arrive unordered or run
 * past the text, so they are clamped and merged here and the text is never interpreted as
 * markup. Pure.
 */

export interface SnippetRun {
  text: string;
  match: boolean;
}

export function snippetRuns(snippet: {
  text: string;
  highlights: readonly { start: number; end: number }[];
}): SnippetRun[] {
  const { text } = snippet;
  const spans = snippet.highlights
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(text.length, start)),
      end: Math.max(0, Math.min(text.length, end)),
    }))
    .filter((span) => span.end > span.start)
    .toSorted((a, b) => a.start - b.start);
  const runs: SnippetRun[] = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(span.start, at);
    if (span.end <= start) continue;
    if (start > at) runs.push({ text: text.slice(at, start), match: false });
    const last = runs.at(-1);
    if (last?.match && start === at) last.text += text.slice(start, span.end);
    else runs.push({ text: text.slice(start, span.end), match: true });
    at = span.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), match: false });
  return runs;
}

/**
 * "24 results", "30+ results" while more pages remain, "No results"; "Searching…" before the
 * first page. A sparse page with a cursor (ADR 0062) still means more may come.
 */
export function resultCountLabel(found: number, more: boolean, searching: boolean): string {
  if (!found && searching) return "Searching…";
  if (!found) return more ? "Searching…" : "No results";
  const count = new Intl.NumberFormat("en-US").format(found);
  return `${count}${more ? "+" : ""} ${found === 1 && !more ? "result" : "results"}`;
}

/** Where a search stands while its index catches up: "Indexing 1,240 recent events". */
export function indexingLabel(pending: number): string | undefined {
  if (pending <= 0) return undefined;
  const count = new Intl.NumberFormat("en-US").format(pending);
  return `Still indexing ${count} recent ${pending === 1 ? "event" : "events"}; newer matches may be missing`;
}
