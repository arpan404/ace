/*
 * How a thread's entity pages (`entities.page`) are cut, one rule for any count: active
 * entities (pending requests, working agents, running tasks) first, newest first, page after
 * page until all are sent, then the inactive ones, newest first. A page holds at most `limit`
 * (and 200) entries and at most `maxBytes` of them, except that an entity larger than that goes
 * alone and whole: the page then exceeds `maxBytes` by that one entity. Nothing is ever cut. An
 * entity too large for any reply (`largest`) is named in `tooLarge` in its place, never dropped.
 *
 * Cursors (`before`, `entitiesBefore`) are versioned: where a reading is, in which part, is in
 * the cursor, so a reading never changes rules midway.
 * - `Number.MAX_SAFE_INTEGER`: from the start, the newest active entity.
 * - `pendingBase + s`: the active entities created before sequence `s`.
 * - `resolvedBase + s`: the inactive ones before `s`; `pendingBase` itself: all inactive ones.
 * - Anything else (a cursor from an older daemon, which was a bare sequence): from the start.
 *
 * Guarantee: a reading from the start to a null cursor lists every entity active both when it
 * began and when it ended, and every entity inactive throughout. One that changed state during
 * the reading may be listed twice, once in each state (readers keep the latest by id); one
 * created during it may be missed, as it is newer than where the reading is.
 */

/** Cursors above this continue the active entities. */
export const pendingBase = 2 ** 52;
/** Cursors above this, up to `pendingBase`, continue the inactive ones. */
export const resolvedBase = 2 ** 51;

/**
 * The most one entity's stored JSON may be (in UTF-16 units) to go on a page: the daemon's
 * outbox refuses a reply whose text is over 64 MiB as UTF-16 (`outbox.ts`), less room for the
 * reply around it.
 */
export const largestPageEntity = 32 * 1024 * 1024 - 64 * 1024;

/** One stored entity: its creation sequence, its stored JSON, and how to decode it. */
export interface PageRow<E> {
  seq: number;
  id: string;
  /** Its stored JSON's UTF-8 bytes and UTF-16 length. */
  bytes: number;
  length: number;
  entity(): E;
  /** What kind of entity it is (an interaction's request kind), read without decoding it all. */
  kind(): string | undefined;
}

/** A thread's entities of one collection, each newest first, created before `below`. */
export interface PageSource<E> {
  active(below: number, most: number): Iterable<PageRow<E>>;
  inactive(below: number, most: number): Iterable<PageRow<E>>;
}

/** An entity too large for any reply, named where it would have been. */
export interface TooLarge {
  id: string;
  kind?: string;
  active: boolean;
  bytes: number;
}

export interface EntityPageOf<E> {
  entries: E[];
  tooLarge: TooLarge[];
  entitiesBefore: number | null;
}

/** Where `before` reads from: which part, and below which creation sequence. */
export function cursorOf(before: number): { active: boolean; below: number } {
  if (before > pendingBase && before < Number.MAX_SAFE_INTEGER)
    return { active: true, below: before - pendingBase };
  if (before === pendingBase) return { active: false, below: Number.MAX_SAFE_INTEGER };
  if (before > resolvedBase && before < pendingBase)
    return { active: false, below: before - resolvedBase };
  return { active: true, below: Number.MAX_SAFE_INTEGER };
}

export function entityPage<E>(
  source: PageSource<E>,
  before: number,
  limit: number,
  maxBytes: number,
  largest = largestPageEntity,
): EntityPageOf<E> {
  const most = Math.min(limit, 200);
  const taken: [number, E][] = [];
  const tooLarge: TooLarge[] = [];
  let count = 0;
  let bytes = 0;
  /** Take `row` if the page has room; false once it is full. */
  const take = (row: PageRow<E>, active: boolean) => {
    if (count >= most || (count && bytes + row.bytes > maxBytes)) return false;
    count++;
    if (row.length > largest) {
      const kind = row.kind();
      tooLarge.push({
        id: row.id,
        ...(kind === undefined ? {} : { kind }),
        active,
        bytes: row.bytes,
      });
      return true;
    }
    taken.push([row.seq, row.entity()]);
    bytes += row.bytes;
    return true;
  };
  const page = (entitiesBefore: number | null): EntityPageOf<E> => ({
    entries: taken.toSorted(([a], [b]) => a - b).map(([, entity]) => entity),
    tooLarge,
    entitiesBefore,
  });
  const at = cursorOf(before);
  let below = at.below;
  if (at.active) {
    for (const row of source.active(below, most + 1)) {
      if (!take(row, true)) return page(pendingBase + below);
      below = row.seq;
    }
    // Every active one sent: the inactive ones follow, from the newest.
    below = Number.MAX_SAFE_INTEGER;
  }
  for (const row of source.inactive(below, most + 1)) {
    if (!take(row, false))
      return page(below === Number.MAX_SAFE_INTEGER ? pendingBase : resolvedBase + below);
    below = row.seq;
  }
  return page(null);
}
