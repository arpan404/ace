import type { ClientApi, RequestOptions, Selection } from "@ace/client";
import { ItemId, type Item, type SearchQuery, type SearchResults } from "@ace/protocol";

export type ConversationSearchKind = "" | NonNullable<SearchQuery["filters"]["kind"]>;
export type ConversationHit = SearchResults["hits"][number];

export interface ConversationSearchSnapshot {
  readonly hits: readonly ConversationHit[];
  readonly cursor: string | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly problem: string | null;
}

export type SearchServiceClient = Pick<ClientApi, "state" | "request">;
export type HistoryWindowClient = Pick<ClientApi, "itemsWindow">;

export function hitId(hit: ConversationHit): string {
  return `${hit.threadId}:${hit.itemId ?? "title"}:${hit.kind}`;
}

export function hitExcerpt(hit: ConversationHit): string {
  return hit.kind === "thread" ? hit.title.text : hit.snippet.text;
}

export function searchProblemForCode(code: string | undefined): string {
  switch (code) {
    case "search_cursor_stale":
      return "The search index changed. Search again to refresh the results.";
    case "search_invalid_query":
      return "That search couldn't run. Try fewer or simpler words.";
    default:
      return "Search couldn't finish. Check the connection and retry.";
  }
}

const OFFLINE_PROBLEM = "Machine offline. Reconnect to search its conversations.";
const SEARCH_LIMIT = 50;

/**
 * One machine and query at a time. Late replies never replace a newer query or
 * append its pages. Mirrors iOS `ConversationSearch` (`apps/ios/Sources/Models/ConversationSearch.swift`).
 */
export class ConversationSearch {
  #snapshot: ConversationSearchSnapshot = {
    hits: [],
    cursor: null,
    loading: false,
    loaded: false,
    problem: null,
  };
  #listeners = new Set<() => void>();
  #generation = 0;
  #inflight: AbortController | undefined;
  #delay: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly selection: Selection<ConversationSearchSnapshot> = {
    getSnapshot: () => this.#snapshot,
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };

  constructor(delays: { sleep?(ms: number, signal: AbortSignal): Promise<void> } = {}) {
    this.#delay =
      delays.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }));
  }

  #publish(next: ConversationSearchSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  /** Cancel any in-flight query so its late reply cannot overwrite newer results. */
  cancel(): void {
    this.#generation++;
    this.#inflight?.abort();
    this.#inflight = undefined;
    if (this.#snapshot.loading) {
      this.#publish({ ...this.#snapshot, loading: false });
    }
  }

  async search(
    client: SearchServiceClient,
    text: string,
    kind: ConversationSearchKind,
    threadId?: string,
    options: RequestOptions = {},
  ): Promise<void> {
    this.#generation++;
    const current = this.#generation;
    this.#inflight?.abort();
    const inflight = new AbortController();
    this.#inflight = inflight;
    // Forward an outer abort into this query's controller. A merged signal
    // kept listeners on the caller's signal after the query settled; this
    // listener is always removed in `finally` below.
    const outer = options.signal;
    const onOuterAbort = () => inflight.abort(outer?.reason);
    if (outer && !outer.aborted) outer.addEventListener("abort", onOuterAbort, { once: true });
    else if (outer?.aborted) inflight.abort(outer.reason);
    const signal = inflight.signal;
    try {
      this.#publish({ hits: [], cursor: null, problem: null, loaded: false, loading: true });
      const query = text.trim();
      if (!query) {
        if (current === this.#generation) this.#publish({ ...this.#snapshot, loading: false });
        return;
      }
      if (client.state !== "ready") {
        if (current === this.#generation) {
          this.#publish({
            hits: [],
            cursor: null,
            loaded: false,
            loading: false,
            problem: OFFLINE_PROBLEM,
          });
        }
        return;
      }
      try {
        await this.#delay(250, signal);
        const reply = await readSearch(client, query, kind, threadId, undefined, {
          ...options,
          signal,
        });
        if (current !== this.#generation || signal.aborted) return;
        if (reply.type === "search.results") {
          this.#publish({
            hits: reply.hits,
            cursor: reply.cursor,
            problem: null,
            loaded: true,
            loading: false,
          });
        } else {
          this.#publish({
            ...this.#snapshot,
            loading: false,
            problem: searchProblemForCode(reply.code),
          });
        }
      } catch (error) {
        if (current !== this.#generation) return;
        if (isAbort(error) || signal.aborted) {
          this.#publish({ ...this.#snapshot, loading: false });
          return;
        }
        this.#publish({
          ...this.#snapshot,
          loading: false,
          problem: error instanceof Error ? error.message : "Search couldn't finish.",
        });
      }
    } finally {
      outer?.removeEventListener("abort", onOuterAbort);
      if (this.#inflight === inflight) this.#inflight = undefined;
    }
  }

  async more(
    client: SearchServiceClient,
    text: string,
    kind: ConversationSearchKind,
    threadId?: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const cursor = this.#snapshot.cursor;
    if (!cursor || this.#snapshot.loading) return;
    const current = this.#generation;
    const signal = options.signal;
    this.#publish({ ...this.#snapshot, loading: true, problem: null });
    try {
      const reply = await readSearch(client, text.trim(), kind, threadId, cursor, options);
      if (current !== this.#generation || signal?.aborted) {
        return;
      }
      if (reply.type === "search.results") {
        const known = new Set(this.#snapshot.hits.map(hitId));
        const hits = [...this.#snapshot.hits];
        for (const hit of reply.hits) {
          if (!known.has(hitId(hit))) {
            known.add(hitId(hit));
            hits.push(hit);
          }
        }
        this.#publish({ ...this.#snapshot, hits, cursor: reply.cursor, loading: false });
      } else {
        this.#publish({
          ...this.#snapshot,
          loading: false,
          problem: searchProblemForCode(reply.code),
        });
      }
    } catch (error) {
      if (current !== this.#generation) return;
      if (isAbort(error) || signal?.aborted) {
        if (current === this.#generation) this.#publish({ ...this.#snapshot, loading: false });
        return;
      }
      this.#publish({
        ...this.#snapshot,
        loading: false,
        problem: error instanceof Error ? error.message : "Search couldn't finish.",
      });
    }
  }
}

async function readSearch(
  client: SearchServiceClient,
  text: string,
  kind: ConversationSearchKind,
  threadId: string | undefined,
  cursor: string | undefined,
  options: RequestOptions,
): Promise<
  | { type: "search.results"; hits: ConversationHit[]; cursor: string | null }
  | { type: "search.error"; code: string | undefined }
> {
  const filters: { kind?: NonNullable<SearchQuery["filters"]["kind"]>; threadId?: string } = {};
  if (kind) filters.kind = kind;
  if (threadId) filters.threadId = threadId;
  const reply = await client.request(
    {
      type: "search.query",
      text,
      limit: SEARCH_LIMIT,
      filters,
      ...(cursor ? { cursor } : {}),
    },
    options,
  );
  if (reply.type === "search.results") {
    return { type: "search.results", hits: [...reply.hits], cursor: reply.cursor };
  }
  return { type: "search.error", code: reply.code };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/**
 * Bounded read around a search hit for the thread's history window. The
 * window never replaces the leased live tail. The caller's signal is
 * forwarded untouched so dismissing the window or leaving the thread cancels
 * the pending request; an abort rejects with an `AbortError`.
 */
export async function readHistoryWindow(
  client: HistoryWindowClient,
  threadId: string,
  target: string,
  options: RequestOptions = {},
): Promise<readonly Item[]> {
  const window = await client.itemsWindow(
    {
      threadId,
      itemId: ItemId.parse(target),
      before: 25,
      after: 25,
    },
    options,
  );
  return window.items;
}
