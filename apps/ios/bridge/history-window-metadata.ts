import type { ThreadSource } from "@ace/client";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";

export interface HistoryBlockSpan {
  id: string;
  items: readonly string[];
  first?: number;
  last?: number;
}

/** Snapshot only bounded resident identity/sequence facts, before a window moves. */
export function historyBlockSpans(
  source: ThreadSource,
  blocks: readonly Block[],
): HistoryBlockSpan[] {
  const spans = blocks.map((block): HistoryBlockSpan => {
    const items = blockItems(block);
    const seqs = items.map((id) => source.itemSeq?.(id));
    const complete = seqs.length > 0 && seqs.every((seq) => seq !== undefined);
    const known = seqs.filter((seq): seq is number => seq !== undefined);
    return {
      id: block.key,
      items,
      ...(complete ? { first: Math.min(...known), last: Math.max(...known) } : {}),
    };
  });
  // Decorations such as a turn ending have no own items. Ground them in their nearest
  // canonical neighbour, rather than losing their measured room on every eviction.
  let previous: HistoryBlockSpan | undefined;
  for (const span of spans) {
    if (span.first !== undefined) previous = span;
    else if (!span.items.length && previous?.last !== undefined) {
      span.items = previous.items;
      span.first = previous.last;
      span.last = previous.last;
    }
  }
  let next: HistoryBlockSpan | undefined;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    if (!span) continue;
    if (span.first !== undefined) next = span;
    else if (!span.items.length && next?.first !== undefined) {
      span.items = next.items;
      span.first = next.first;
      span.last = next.first;
    }
  }
  return spans;
}

/** Deletion/regrouping is distinct from eviction; direction alone is never evidence. */
export function historyWindowMetadata(
  previous: readonly HistoryBlockSpan[],
  next: readonly HistoryBlockSpan[],
  deleted: (id: string) => boolean,
  before: number | null,
  after: number | null,
) {
  const present = new Set(next.map((block) => block.id));
  const items = new Set(next.flatMap((block) => block.items));
  const known = next.flatMap((block) =>
    block.first !== undefined && block.last !== undefined ? [block.first, block.last] : [],
  );
  const low = known.length ? Math.min(...known) : undefined;
  const high = known.length ? Math.max(...known) : undefined;
  const evictedLeading: string[] = [],
    evictedTrailing: string[] = [],
    removed: string[] = [];
  for (const block of previous) {
    if (present.has(block.id)) continue;
    if (block.items.some((id) => deleted(id) || items.has(id))) removed.push(block.id);
    else if (block.last !== undefined && low !== undefined && block.last < low)
      evictedLeading.push(block.id);
    else if (block.first !== undefined && high !== undefined && block.first > high)
      evictedTrailing.push(block.id);
    else removed.push(block.id);
  }
  const blockSeqs: Record<string, { first: number; last: number }> = {};
  // Evicted spans must travel with the reply too: native folds their measured room into
  // bounded sequence ranges after their payload has already left the resident window.
  for (const block of [...previous, ...next])
    if (block.first !== undefined && block.last !== undefined)
      blockSeqs[block.id] = { first: block.first, last: block.last };
  return {
    evictedLeading,
    evictedTrailing,
    deleted: removed,
    beforeSeq: before,
    afterSeq: after,
    beforeCount: before === null ? 0 : null,
    afterCount: after === null ? 0 : null,
    blockSeqs,
  };
}
