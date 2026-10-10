export interface FindHit {
  line: number;
  column: number;
}

export function searchLines(lines: readonly string[], query: string, limit = 10_000): FindHit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  for (let line = 0; line < lines.length && hits.length < limit; line++) {
    const content = lines[line] ?? "";
    for (let at = content.indexOf(needle); at >= 0 && hits.length < limit;) {
      hits.push({ line, column: at });
      at = content.indexOf(needle, at + needle.length);
    }
  }
  return hits;
}

export function findHits(text: string, query: string, limit = 10_000): FindHit[] {
  return query ? searchLines(text.toLowerCase().split("\n"), query, limit) : [];
}
