import type { ClientApi } from "@ace/client";
import type { FileSearchFile, FileSearchSummary } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import { checkoutError, type CheckoutError } from "./checkout-source.ts";
import { searchContents, type ContentQuery } from "./content-search-source.ts";

/** How long typing pauses before the search runs. */
export const searchDelay = 250;

export interface ContentSearchState {
  query: ContentQuery;
  status: "idle" | "searching" | "done" | "failed";
  /** Matching files in the order the daemon found them, each file's lines merged. */
  files: readonly FileSearchFile[];
  /** Lines shown so far. */
  lines: number;
  /** Matches shown so far, every highlighted range of every line. */
  matches: number;
  summary: FileSearchSummary | undefined;
  error: CheckoutError | undefined;
}

/** A file's matches as the view counts them: each highlighted range, at least one a line. */
export function matchCount(file: FileSearchFile): number {
  let total = 0;
  for (const line of file.lines) total += Math.max(1, line.ranges.length);
  return total;
}

const emptyQuery: ContentQuery = {
  pattern: "",
  matchCase: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
};

/**
 * One thread's content search, shared by every Files tab of the thread so opening a result
 * keeps the list. A change to the query cancels the search before it (the daemon stops walking)
 * and empties the list at once, so no row of the old query stays to be clicked; only the new
 * search waits for typing to pause.
 */
export class ContentSearchStore {
  readonly #client: ClientApi;
  readonly #threadId: string;
  readonly #listeners = new Set<() => void>();
  #state: ContentSearchState = {
    query: emptyQuery,
    status: "idle",
    files: [],
    lines: 0,
    matches: 0,
    summary: undefined,
    error: undefined,
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: AbortController | undefined;

  constructor(client: ClientApi, threadId: string) {
    this.#client = client;
    this.#threadId = threadId;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get state(): ContentSearchState {
    return this.#state;
  }

  /** Change the query; the search follows once typing pauses (at once with `now`). */
  update(patch: Partial<ContentQuery>, now = false): void {
    const query = { ...this.#state.query, ...patch };
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#cancel();
    this.#set({
      query,
      status: query.pattern ? "searching" : "idle",
      files: [],
      lines: 0,
      matches: 0,
      summary: undefined,
      error: undefined,
    });
    if (!query.pattern) return;
    if (now) this.run();
    else this.#timer = setTimeout(() => this.run(), searchDelay);
  }

  /** Search now with the current query (Enter, or Try again). */
  run(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const query = this.#state.query;
    this.#cancel();
    if (!query.pattern) return;
    const controller = new AbortController();
    this.#running = controller;
    const requestId = `search-${crypto.randomUUID()}`;
    this.#set({
      status: "searching",
      files: [],
      lines: 0,
      matches: 0,
      summary: undefined,
      error: undefined,
    });
    searchContents(this.#client, this.#threadId, query, {
      requestId,
      signal: controller.signal,
      onFiles: (files) => {
        if (this.#running === controller) this.#append(files);
      },
    }).then(
      (summary) => {
        if (this.#running !== controller) return;
        this.#running = undefined;
        this.#set({ status: "done", summary });
      },
      (error: unknown) => {
        if (this.#running !== controller) return;
        this.#running = undefined;
        this.#set({ status: "failed", error: checkoutError(error) });
      },
    );
  }

  /** Stop listening for the thread: the search running for it stops too. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#cancel();
  }

  #cancel(): void {
    const running = this.#running;
    this.#running = undefined;
    running?.abort();
  }

  /** Merge a batch: a file split across batches stays one group. */
  #append(batch: readonly FileSearchFile[]): void {
    const files = [...this.#state.files];
    let lines = this.#state.lines;
    let matches = this.#state.matches;
    for (const file of batch) {
      lines += file.lines.length;
      matches += matchCount(file);
      const last = files.at(-1);
      if (last?.path === file.path)
        files[files.length - 1] = { path: file.path, lines: [...last.lines, ...file.lines] };
      else files.push(file);
    }
    this.#set({ files, lines, matches });
  }

  #set(patch: Partial<ContentSearchState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

const stores = new WeakMap<ClientApi, Map<string, ContentSearchStore>>();

/** The thread's search store for this client, made on first use. */
export function contentSearchStore(client: ClientApi, threadId: string): ContentSearchStore {
  let threads = stores.get(client);
  if (!threads) {
    threads = new Map();
    stores.set(client, threads);
  }
  let store = threads.get(threadId);
  if (!store) {
    store = new ContentSearchStore(client, threadId);
    threads.set(threadId, store);
  }
  return store;
}

export function useContentSearch(store: ContentSearchStore): ContentSearchState {
  return useSyncExternalStore(store.subscribe, () => store.state);
}
