import type { ClientApi } from "@ace/client";
import type { TurnSummary } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useOptionalThreadNav, useWatched, Watched } from "./nav.tsx";

/*
 * The thread's turn index (ADR 0062) as the timeline, collapsed turns and jumped windows read
 * it: turns in fixed blocks of 50 ordinals, each block one cached read that is dropped soon
 * after nothing shows it, so a thread of 100,000 turns costs what is on screen. Ordinals are
 * stable and dense (1..N), which makes a block's place in the list known before it loads.
 */

export const turnBlockSize = 50;
/** Unobserved blocks leave the cache this soon: a long scroll never accumulates the index. */
const blockGcMs = 20_000;

/** The block holding `ordinal` (0-based). */
export const blockOf = (ordinal: number): number => Math.floor((ordinal - 1) / turnBlockSize);

export interface TurnIndexHead {
  /** The newest turn's ordinal, so the thread has this many turns; 0 before the first. */
  count: number;
  latest: TurnSummary | undefined;
  /** Indexing is behind the thread (an upgrade backfilling, ADR 0062). */
  ready: boolean;
}

const unknownTurn = new Watched<number | undefined>(undefined);

/**
 * The newest turn, which says how many there are. Read again whenever the live tail shows a
 * newer turn than the last read did, so new turns join the list and the block they land in is
 * read again, without polling.
 */
export function useTurnHead(
  threadId: string,
  options: { enabled?: boolean } = {},
): TurnIndexHead | undefined {
  const nav = useOptionalThreadNav();
  const liveTurn = useWatched(nav?.liveTurn ?? unknownTurn);
  const query = useDaemonQuery<TurnIndexHead>({
    queryKey: ["thread-turns", threadId, "head", liveTurn ?? 0],
    read: async (client: ClientApi, signal) => {
      const page = await client.turnsPage({ threadId, limit: 1 }, { signal });
      const latest = page.turns.at(-1);
      return { count: latest?.ordinal ?? 0, latest, ready: page.ready };
    },
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    gcTime: blockGcMs,
    // A new turn's key replaces the last one; keep showing it until the new read lands.
    placeholderData: (previous) => previous,
  });
  const head = query.data;
  // The live tail may already show a turn the index is about to report.
  return head && liveTurn !== undefined && liveTurn > head.count
    ? { ...head, count: liveTurn }
    : head;
}

/**
 * The turns of one block, by ordinal. A reply may hold fewer turns than asked (its byte
 * budget): the read continues from the reply's cursor until the block is covered.
 */
async function readBlock(
  client: ClientApi,
  threadId: string,
  block: number,
  signal: AbortSignal,
): Promise<ReadonlyMap<number, TurnSummary>> {
  const first = block * turnBlockSize + 1;
  const turns = new Map<number, TurnSummary>();
  let before: number | undefined = first + turnBlockSize;
  for (let reads = 0; before !== undefined && reads < turnBlockSize; reads++) {
    const page = await client.turnsPage(
      { threadId, before, limit: Math.min(100, before - first) },
      { signal },
    );
    for (const turn of page.turns) if (turn.ordinal >= first) turns.set(turn.ordinal, turn);
    const oldest = page.turns[0]?.ordinal;
    before = page.before !== null && oldest !== undefined && oldest > first ? oldest : undefined;
  }
  return turns;
}

/**
 * One block of turns, while something shows it. The block holding the newest turn is read again
 * as turns join it: its key carries how far the thread had got, so a block read while the
 * thread was at turn 92 is not mistaken for one that ends at 100.
 */
export function useTurnBlock(
  threadId: string,
  block: number | undefined,
): ReadonlyMap<number, TurnSummary> | undefined {
  const head = useTurnHead(threadId)?.count;
  const end = ((block ?? 0) + 1) * turnBlockSize;
  const filled = head === undefined ? undefined : head >= end ? "full" : head;
  const query = useDaemonQuery<ReadonlyMap<number, TurnSummary>>({
    queryKey: ["thread-turns", threadId, "block", block, filled],
    // While a block the thread has grown into is read again, its earlier read stands in.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === block ? previous : undefined,
    read: (client: ClientApi, signal) => readBlock(client, threadId, block ?? 0, signal),
    enabled: block !== undefined && block >= 0 && filled !== undefined,
    // Settled turns rarely change (a late background result can still reach one).
    staleTime: filled === "full" ? 30_000 : 2_000,
    gcTime: blockGcMs,
  });
  return query.data;
}

/** One turn's summary, from the block that holds it. */
export function useTurnSummary(
  threadId: string,
  ordinal: number | undefined,
): TurnSummary | undefined {
  const block = useTurnBlock(threadId, ordinal === undefined ? undefined : blockOf(ordinal));
  return ordinal === undefined ? undefined : block?.get(ordinal);
}
