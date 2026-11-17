import { tiered, type RankingTier } from "./ranking.ts";

/*
 * Search on the device (ADR 0168 §11): name, then title, then one line and keywords, rarer words
 * counting more, a typo forgiven, the publisher's tier a bounded multiplier (ADR 0174 §15). Pure,
 * and run on the daemon's own copy of the index, so a query never leaves the machine; the Worker
 * runs the same for its web page.
 */

export interface Searchable {
  source: string;
  type: string;
  name: string;
  title: string;
  line: string;
  keywords: readonly string[];
  categories: readonly string[];
  reviewed: boolean;
  downloads: number;
  /** The publisher's ranking tier; absent is everyone else. */
  tier?: RankingTier | undefined;
}

export interface SearchQuery {
  query: string;
  type?: string | undefined;
  category?: string | undefined;
  source?: string | undefined;
}

const weights = { name: 8, title: 4, line: 2, keywords: 2 } as const;
type Field = keyof typeof weights;
const fields = Object.keys(weights) as Field[];

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Edit distance with adjacent swaps, stopping once it passes `limit`. */
export function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, (before[j - 2] ?? 0) + 1);
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** How well `term` matches one word: exactly 1, as a prefix 0.8, with a typo 0.5. */
function match(term: string, word: string): number {
  if (term === word) return 1;
  if (term.length >= 2 && word.startsWith(term)) return 0.8;
  if (term.length >= 4) {
    const limit = term.length >= 8 ? 2 : 1;
    if (distance(term, word, limit) <= limit) return 0.5;
    // A typo in a word still being typed: compare against the word's same-length start.
    if (word.length > term.length && distance(term, word.slice(0, term.length), 1) <= 1) return 0.4;
  }
  return 0;
}

interface Indexed {
  item: Searchable;
  words: Record<Field, string[]>;
}

function indexOf(item: Searchable): Indexed {
  return {
    item,
    words: {
      name: words(item.name),
      title: words(item.title),
      line: words(item.line),
      keywords: item.keywords.flatMap(words),
    },
  };
}

const best = (term: string, list: readonly string[]) =>
  list.reduce((top, word) => Math.max(top, match(term, word)), 0);

/** Reviewed first, then by downloads with the tier's multiplier, then by name: the order with nothing searched. */
function byStanding(a: Searchable, b: Searchable): number {
  if (a.reviewed !== b.reviewed) return a.reviewed ? -1 : 1;
  const [left, right] = [tiered(a.downloads, a.tier), tiered(b.downloads, b.tier)];
  if (left !== right) return right - left;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.type < b.type ? -1 : 1;
}

/** `items` that pass the filters and match every word of the query, best first. */
export function search<T extends Searchable>(items: readonly T[], query: SearchQuery): T[] {
  const kept = items.filter(
    (item) =>
      (!query.type || item.type === query.type) &&
      (!query.source || item.source === query.source) &&
      (!query.category || (item.reviewed && item.categories.includes(query.category))),
  );
  const terms = [...new Set(words(query.query))];
  if (terms.length === 0) return kept.toSorted(byStanding);
  const indexed = kept.map(indexOf);
  // Rarer words count more: how many entries each term matches at all.
  const rarity = new Map<string, number>();
  for (const term of terms) {
    const found = indexed.filter((entry) =>
      fields.some((field) => best(term, entry.words[field]) >= 0.8),
    ).length;
    rarity.set(term, Math.log(1 + (indexed.length + 1) / (1 + found)));
  }
  const whole = query.query.trim().toLowerCase();
  const scored: { item: T; score: number }[] = [];
  for (const entry of indexed) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      let top = 0;
      for (const field of fields)
        top = Math.max(top, weights[field] * best(term, entry.words[field]));
      if (top === 0) {
        all = false;
        break;
      }
      score += top * (rarity.get(term) ?? 1);
    }
    if (!all) continue;
    if (entry.item.name === whole || entry.item.title.toLowerCase() === whole) score *= 1.5;
    scored.push({ item: entry.item as T, score: tiered(score, entry.item.tier) });
  }
  return scored
    .toSorted((a, b) => (b.score !== a.score ? b.score - a.score : byStanding(a.item, b.item)))
    .map((entry) => entry.item);
}
