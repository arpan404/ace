import { boundedEntity } from "./entity-cut.ts";

/*
 * How a thread's entity pages (`entities.page`) are cut, the same for any count: active
 * entities (pending requests, working agents) first, newest first, page after page until all
 * are sent, then the inactive ones, newest first. Each page holds at most 200 entries and at
 * most `maxBytes` of them; an entity larger than that goes alone, cut (`boundedEntity`).
 *
 * Which of the two a page continues is carried in its cursor (`before`): above `activeBase` the
 * actives below `before - activeBase` (`Number.MAX_SAFE_INTEGER`: from the newest), at or below
 * it the inactive ones below `before`, the meaning a snapshot's cursors have. So a pending
 * request is never behind a resolved one, and a reading never changes rules midway. One
 * resolved between two reads may be listed twice, as pending and then as resolved.
 */

/** Cursors above this continue the active entities; at or below, creation sequences. */
export const activeBase = 2 ** 52;

/** One stored entity: its creation sequence, its stored JSON's bytes, and how to decode it. */
export interface PageRow<E> {
  seq: number;
  bytes: number;
  entity(): E;
}

/** A thread's entities of one collection, each newest first, created before `below`. */
export interface PageSource<E> {
  active(below: number, most: number): Iterable<PageRow<E>>;
  inactive(below: number, most: number): Iterable<PageRow<E>>;
}

export function entityPage<E>(
  source: PageSource<E>,
  before: number,
  limit: number,
  maxBytes: number,
): { entries: E[]; entitiesBefore: number | null } {
  const most = Math.min(limit, 200);
  const taken: [number, E][] = [];
  let bytes = 0;
  /** Take `row` if the page has room; false once it is full. */
  const take = (row: PageRow<E>) => {
    if (taken.length >= most || (taken.length && bytes + row.bytes > maxBytes)) return false;
    let entity = row.entity();
    let size = row.bytes;
    if (size > maxBytes) {
      entity = boundedEntity(entity, maxBytes);
      size = Buffer.byteLength(JSON.stringify(entity));
    }
    taken.push([row.seq, entity]);
    bytes += size;
    return true;
  };
  /** What was taken, oldest first. */
  const page = (entitiesBefore: number | null) => ({
    entries: taken.toSorted(([a], [b]) => a - b).map(([, entity]) => entity),
    entitiesBefore,
  });
  let below = before;
  if (before > activeBase) {
    const from = before >= Number.MAX_SAFE_INTEGER ? before : before - activeBase;
    let last = from;
    for (const row of source.active(from, most + 1)) {
      if (!take(row)) return page(activeBase + last);
      last = row.seq;
    }
    // Every active one sent: the inactive ones follow, from the newest.
    below = activeBase;
  }
  let last = below;
  for (const row of source.inactive(below, most + 1)) {
    if (!take(row)) return page(last);
    last = row.seq;
  }
  return page(null);
}
