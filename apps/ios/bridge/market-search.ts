import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";

/*
 * Search past its first page (spec item 1): the phone asks from an offset and is told where to
 * go on from. A category lists only what ace reviewed, so that filter runs here, before the
 * page is cut, reading on until the page is full: filtered after, a page of unreviewed entries
 * looked like an empty category. Pure apart from `read`.
 */

type Search = Extract<MarketOperation, { op: "search" }>;
type Searched = Extract<MarketResult, { op: "search" }>;

/** At most this many of the daemon's pages are read for one answer. */
const pagesPerAnswer = 4;

export interface SearchedPage {
  /** The daemon's answer to the first read, with the rows of every read, filtered. */
  result: MarketResult;
  /** The offset the next page starts at; null when there is nothing after these rows. */
  next: number | null;
}

/**
 * Reads `search` from its offset until a page's worth of rows is found or the results end.
 * An error on the first read is the answer; on a later one, what was found stands.
 */
export async function searchPages(
  search: Search,
  reviewedOnly: boolean,
  read: (operation: Search) => Promise<MarketResult>,
): Promise<SearchedPage> {
  const limit = search.limit;
  const rows: Searched["entries"] = [];
  let first: Searched | undefined;
  let offset = search.offset;
  for (let page = 0; page < pagesPerAnswer; page++) {
    const result = await read({ ...search, offset });
    if (result.op !== "search") {
      if (!first) return { result, next: null };
      break;
    }
    first ??= result;
    let taken = 0;
    for (const entry of result.entries) {
      taken++;
      if (reviewedOnly && !entry.reviewed) continue;
      rows.push(entry);
      if (rows.length === limit) break;
    }
    offset += taken;
    if (rows.length === limit || offset >= result.total || result.entries.length === 0) {
      return { result: { ...first, entries: rows }, next: offset < result.total ? offset : null };
    }
  }
  if (!first) return { result: { op: "error", code: "failed", message: "" }, next: null };
  return { result: { ...first, entries: rows }, next: offset < first.total ? offset : null };
}
