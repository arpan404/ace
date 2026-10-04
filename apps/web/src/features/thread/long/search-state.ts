import type { ClientApi, ThreadSearchInput } from "@ace/client";
import type { ThreadSearchResponse } from "@ace/protocol";

/*
 * Searching one thread (ADR 0062 `thread.search`). Each query keeps its cursor, so paging keeps
 * the query, scope and filter it was started with; a sparse page with a cursor is read past
 * (the daemon examines a bounded slice per request), and only a null cursor ends the results.
 * Hits held are capped, so a query matching half a million items costs a bounded list.
 */

export type SearchFilter = NonNullable<ThreadSearchInput["filter"]>;
export type SearchHit = ThreadSearchResponse["hits"][number];

export interface SearchQuery {
  text: string;
  filter: SearchFilter | undefined;
  /** The thread and its linked subagent threads. */
  tree: boolean;
}

export interface SearchSnapshot {
  query: SearchQuery | undefined;
  hits: readonly SearchHit[];
  /** The daemon has more pages. */
  more: boolean;
  loading: boolean;
  failed: boolean;
  /** Events not yet indexed: newer matches may be missing. */
  pending: number;
  /** The client holds as many hits as it keeps; refine the query to see others. */
  capped: boolean;
}

/** Hits kept for one query. */
export const maxHits = 500;
const pageSize = 50;
/** Pages one request for more may read through before pausing for the reader. */
const sparseReads = 20;

const empty: SearchSnapshot = {
  query: undefined,
  hits: [],
  more: false,
  loading: false,
  failed: false,
  pending: 0,
  capped: false,
};

const hitKey = (hit: SearchHit) => `${hit.threadId}\u0000${hit.itemId}`;

export class ThreadSearch {
  private state: SearchSnapshot = empty;
  private listeners = new Set<() => void>();
  private cursor: string | undefined;
  private abort: AbortController | undefined;
  private client: ClientApi;
  private threadId: string;
  constructor(client: ClientApi, threadId: string) {
    this.client = client;
    this.threadId = threadId;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): SearchSnapshot => this.state;
  private set(patch: Partial<SearchSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Start a query (an empty one clears the results). */
  search(query: SearchQuery): void {
    this.abort?.abort();
    this.abort = undefined;
    this.cursor = undefined;
    const text = query.text.trim();
    if (!text) {
      this.state = empty;
      for (const listener of this.listeners) listener();
      return;
    }
    this.state = { ...empty, query: { ...query, text }, more: true };
    void this.more();
  }

  /** Read on from the cursor until a page's worth of hits arrives or the results end. */
  async more(): Promise<void> {
    const query = this.state.query;
    if (!query || !this.state.more || this.state.loading || this.state.capped) return;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ loading: true, failed: false });
    const seen = new Set(this.state.hits.map(hitKey));
    let hits = [...this.state.hits];
    const before = hits.length;
    try {
      for (let reads = 0; reads < sparseReads; reads++) {
        const reply = await this.client.threadSearch(
          {
            threadId: this.threadId,
            text: query.text,
            scope: query.tree ? "tree" : "thread",
            ...(query.filter ? { filter: query.filter } : {}),
            limit: pageSize,
            ...(this.cursor ? { cursor: this.cursor } : {}),
          },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        for (const hit of reply.hits) {
          const key = hitKey(hit);
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push(hit);
        }
        this.cursor = reply.cursor ?? undefined;
        const capped = hits.length >= maxHits;
        if (capped) hits = hits.slice(0, maxHits);
        this.set({ hits, pending: reply.pending, more: reply.cursor !== null, capped });
        if (reply.cursor === null || capped || hits.length - before >= pageSize) break;
      }
      this.set({ loading: false });
    } catch {
      if (!abort.signal.aborted) this.set({ loading: false, failed: true });
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  dispose(): void {
    this.abort?.abort();
    this.abort = undefined;
  }
}
