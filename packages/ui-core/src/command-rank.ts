/**
 * Ranking for the command palette: how well a query matches one item, best first. The query
 * is split into words and every word must be found, in the item's label or in its other fields
 * (project, branch, pull request, keywords). Each word scores by how it was found, exact word
 * over word prefix over anywhere inside, and a word found in the label always outranks one found
 * only in another field. A label equal to (or starting with) the whole query comes first. Equal
 * scores are broken by recency (`compareRanked`).
 */

export interface RankItem {
  label: string;
  /** Other text that finds the item: its project, branch, pull request, keywords. */
  fields?: readonly (string | undefined)[] | undefined;
  /** When it was last opened or run (ms); newer wins a tie. */
  at?: number | undefined;
}

/** 3 exact word, 2 word prefix, 1 inside, 0 not found. */
type Found = 0 | 1 | 2 | 3;

const words = (text: string) => text.split(/[^\p{L}\p{N}#]+/u).filter(Boolean);

function find(token: string, text: string): Found {
  if (!text.includes(token)) return 0;
  if (text === token) return 3;
  const parts = words(text);
  if (parts.includes(token)) return 3;
  if (text.startsWith(token) || parts.some((part) => part.startsWith(token))) return 2;
  return 1;
}

/** The query's words, lowercased. */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well `query` matches `item`: a score (higher is better) or null when any query word is
 * missing from the item. An empty query matches everything at 0.
 */
export function rankCommand(query: string, item: RankItem): number | null {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const label = item.label.toLowerCase();
  const fields = (item.fields ?? []).flatMap((field) => (field ? [field.toLowerCase()] : []));
  const whole = tokens.join(" ");
  let score = label === whole ? 1000 : label.startsWith(whole) ? 500 : 0;
  for (const token of tokens) {
    const inLabel = find(token, label);
    if (inLabel) {
      score += 30 + inLabel * 10;
      continue;
    }
    const inField = Math.max(0, ...fields.map((field) => find(token, field)));
    if (!inField) return null;
    score += inField * 10;
  }
  return score;
}

/** Sort order for ranked items: higher score first, then the more recent. */
export function compareRanked(
  a: { score: number; at?: number | undefined },
  b: { score: number; at?: number | undefined },
): number {
  return b.score - a.score || (b.at ?? 0) - (a.at ?? 0);
}

/**
 * The parts of `label` the query's words matched, for bolding: sorted, merged [start, end)
 * ranges. Each word marks its first match at a word start, else its first match anywhere.
 */
export function matchRanges(query: string, label: string): [number, number][] {
  const text = label.toLowerCase();
  const ranges: [number, number][] = [];
  for (const token of queryTokens(query)) {
    let at = -1;
    for (const match of text.matchAll(/[\p{L}\p{N}#]+/gu))
      if (text.startsWith(token, match.index)) {
        at = match.index;
        break;
      }
    if (at === -1) at = text.indexOf(token);
    if (at !== -1) ranges.push([at, at + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
