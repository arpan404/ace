/**
 * Ranking for the command palette: how well a query matches one item, best first. Tiers, from
 * the strongest: the whole label, a label prefix, every query word starting a label word (any
 * order), the query's letters in order (fuzzy, tighter is better), then a match only in the
 * item's other searchable text (project, branch). Small bonuses lift commands over threads when
 * the query reads as a command, and items opened in the last day.
 */

export interface RankItem {
  label: string;
  /** Other text that finds the item (its project, branch, id), at the lowest tier. */
  extra?: string | undefined;
  /** Commands win ties against threads when the query matches their label. */
  command?: boolean | undefined;
  /** When it was last opened (ms). */
  openedAt?: number | undefined;
}

const tier = { exact: 1000, prefix: 800, words: 600, fuzzy: 300, extra: 100 } as const;
const dayMs = 24 * 60 * 60 * 1000;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The query's letters in order inside `text`: a score for how tight they sit, or null. */
function subsequence(query: string, text: string): number | null {
  let at = 0;
  let gaps = 0;
  let last = -1;
  for (const char of query) {
    if (char === " ") continue;
    const found = text.indexOf(char, at);
    if (found === -1) return null;
    if (last !== -1) gaps += found - last - 1;
    last = found;
    at = found + 1;
  }
  return Math.max(0, 200 - gaps * 8);
}

/**
 * How well `query` matches `item`: a score (higher is better) or null for no match. An empty
 * query matches everything at 0.
 */
export function rankCommand(query: string, item: RankItem, now?: number): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = item.label.toLowerCase();
  let score: number | null = null;
  if (label === q) score = tier.exact;
  else if (label.startsWith(q)) score = tier.prefix - Math.min(label.length - q.length, 100);
  else {
    const labelWords = words(label);
    const queryWords = words(q);
    if (
      queryWords.length > 0 &&
      queryWords.every((word) => labelWords.some((candidate) => candidate.startsWith(word)))
    )
      score = tier.words - Math.min(label.length, 100) * 0.1;
    else {
      const fuzzy = subsequence(q, label);
      // Tighter first, then shorter: "nwthr" means "New thread" before "New thread on main".
      if (fuzzy !== null) score = tier.fuzzy + fuzzy * 0.5 - Math.min(label.length, 100) * 0.1;
      else if (item.extra?.toLowerCase().includes(q)) score = tier.extra;
    }
  }
  if (score === null) return null;
  if (item.command && score > tier.extra) score += 25;
  if (now !== undefined && item.openedAt !== undefined && now - item.openedAt < dayMs) score += 50;
  return score;
}

/**
 * The parts of `label` the query matched, for bolding: [start, end) ranges. Prefers a whole
 * contiguous match, then each query word at a word start, then the fuzzy letters.
 */
export function matchRanges(query: string, label: string): [number, number][] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const text = label.toLowerCase();
  const whole = text.indexOf(q);
  if (whole !== -1) return [[whole, whole + q.length]];
  const ranges: [number, number][] = [];
  const queryWords = words(q);
  const starts = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const used = new Set<number>();
  const wordRanges = queryWords.map((word) => {
    const hit = starts.find((match) => !used.has(match.index) && match[0].startsWith(word));
    if (!hit) return null;
    used.add(hit.index);
    return [hit.index, hit.index + word.length] as [number, number];
  });
  if (wordRanges.every((range) => range !== null))
    return wordRanges.filter((range) => range !== null).toSorted((a, b) => a[0] - b[0]);
  let at = 0;
  for (const char of q) {
    if (char === " ") continue;
    const found = text.indexOf(char, at);
    if (found === -1) return [];
    const previous = ranges.at(-1);
    if (previous && previous[1] === found) previous[1] = found + 1;
    else ranges.push([found, found + 1]);
    at = found + 1;
  }
  return ranges;
}
