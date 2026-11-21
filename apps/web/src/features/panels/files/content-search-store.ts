import type { ClientApi } from "@ace/client";
import type { FileSearchFile, FileSearchSummary } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import { checkoutError, type CheckoutError } from "./checkout-source.ts";
import { searchContents, type ContentQuery } from "./content-search-source.ts";
import {
  emptyContentQuery,
  hitKey,
  lineHit,
  mergeSearchBatch,
  nothingFound,
  searchGlobs,
  type SearchHit,
} from "@ace/ui-core";

export { hitKey, lineHit, matchCount, type SearchHit } from "@ace/ui-core";
import { watchFolders, type FolderWatchHandle } from "./folder-watch.ts";

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
  /** Files whose lines the person folded away; a new query unfolds them all. */
  closed: ReadonlySet<string>;
  /** The hit last opened (`hitKey`), where F4 and ⇧F4 step from. */
  cursor: string | undefined;
}

/** The hit `delta` steps away from `cursor` among every result line, wrapping round. */
export function steppedHit(
  files: readonly FileSearchFile[],
  cursor: string | undefined,
  delta: 1 | -1,
): SearchHit | undefined {
  const hits = files.flatMap((file) => file.lines.map((line) => lineHit(file.path, line)));
  if (!hits.length) return undefined;
  const at = hits.findIndex((hit) => hitKey(hit.path, hit.line) === cursor);
  const next = at < 0 ? (delta > 0 ? 0 : hits.length - 1) : at + delta;
  return hits[(next + hits.length) % hits.length];
}

/** The folder holding `path`, as `files.watch` names it ("" is the root). */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The folders a query searches: each include glob's folders before its first wildcard
 * ("src/**" searches src), or the whole checkout ("") when a glob names none ("*.ts").
 */
function searchedRoots(query: Pick<ContentQuery, "include">): string[] {
  const roots = searchGlobs(query.include).map((glob) => {
    const fixed: string[] = [];
    for (const part of glob
      .replace(/^\.?\//, "")
      .split("/")
      .slice(0, -1)) {
      if (/[*?[\]{}!]/.test(part)) break;
      fixed.push(part);
    }
    return fixed.join("/");
  });
  return roots.length && !roots.includes("") ? [...new Set(roots)] : [""];
}

/**
 * One thread's content search, shared by every Files tab of the thread so opening a result
 * keeps the list, its folds, its scroll and the hit last opened. A change to the query cancels
 * the search before it (the daemon stops walking) and empties the list at once, so no row of the
 * old query stays to be clicked; only the new search waits for typing to pause. The folders it
 * searches and those of the files found join the thread's watch set: when the daemon says one
 * changed (an agent wrote it), or a save lands anywhere under them, the same query runs again
 * quietly and its results replace the old ones once complete, even when it found nothing.
 */
export class ContentSearchStore {
  readonly #client: ClientApi;
  readonly #threadId: string;
  readonly #listeners = new Set<() => void>();
  #state: ContentSearchState = {
    query: emptyContentQuery,
    status: "idle",
    files: [],
    lines: 0,
    matches: 0,
    summary: undefined,
    error: undefined,
    closed: new Set(),
    cursor: undefined,
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #running: AbortController | undefined;
  readonly #watch: FolderWatchHandle;
  readonly #stopListening: () => void;
  #scrollTop = 0;

  constructor(client: ClientApi, threadId: string) {
    this.#client = client;
    this.#threadId = threadId;
    this.#watch = watchFolders(client, threadId);
    this.#stopListening = client.onMessage((message) => {
      if (message.type === "files.folders_changed") {
        if (message.threadId !== threadId) return;
        if (message.rescan || message.folders.some((folder) => this.#searches(folder)))
          this.#refreshSoon();
      } else if (message.type === "files.changed") {
        // A save through ace names its path. It carries no thread, so a save of the same path
        // in another checkout runs one extra quiet search, never a missed one.
        const { path, destination } = message.change;
        if (
          this.#searches(folderOf(path)) ||
          (destination && this.#searches(folderOf(destination)))
        )
          this.#refreshSoon();
      }
    });
  }

  /** Where the result list was scrolled; the list comes back there when it mounts again. */
  get scrolled(): number {
    return this.#scrollTop;
  }

  keepScroll(top: number): void {
    this.#scrollTop = top;
  }

  /** Fold or unfold a file's lines. */
  toggle(path: string): void {
    const closed = new Set(this.#state.closed);
    if (!closed.delete(path)) closed.add(path);
    this.#set({ closed });
  }

  /** The hit just opened: F4 steps on from it. */
  pick(hit: SearchHit): void {
    this.#set({ cursor: hitKey(hit.path, hit.line) });
  }

  /** Step to the next (1) or previous (-1) hit, and make it the current one. */
  step(delta: 1 | -1): SearchHit | undefined {
    const hit = steppedHit(this.#state.files, this.#state.cursor, delta);
    if (hit) this.pick(hit);
    return hit;
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
      closed: new Set(),
      cursor: undefined,
    });
    this.#scrollTop = 0;
    this.#watch.set([]);
    if (!query.pattern) return;
    if (now) this.run();
    else this.#timer = setTimeout(() => this.run(), searchDelay);
  }

  /** Search now with the current query (Enter, or Try again). */
  run(): void {
    this.#search(false);
  }

  /**
   * Search with the current query. A quiet search (a refresh) keeps the shown results until the
   * new ones are complete, so the list neither empties nor jumps meanwhile.
   */
  #search(quiet: boolean): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const query = this.#state.query;
    this.#cancel();
    if (!query.pattern) return;
    const controller = new AbortController();
    this.#running = controller;
    const requestId = `search-${crypto.randomUUID()}`;
    let found = nothingFound;
    if (!quiet)
      this.#set({ status: "searching", ...nothingFound, summary: undefined, error: undefined });
    searchContents(this.#client, this.#threadId, query, {
      requestId,
      signal: controller.signal,
      onFiles: (files) => {
        if (this.#running !== controller) return;
        if (quiet) found = mergeSearchBatch(found, files);
        else this.#set(mergeSearchBatch(this.#state, files));
      },
    }).then(
      (summary) => {
        if (this.#running !== controller) return;
        this.#running = undefined;
        this.#set({ status: "done", summary, ...(quiet ? found : {}) });
        this.#watch.set(new Set([...searchedRoots(this.#state.query), ...this.#folders()]));
      },
      (error: unknown) => {
        if (this.#running !== controller) return;
        this.#running = undefined;
        // A refresh that failed leaves the results it would have replaced.
        if (!quiet) this.#set({ status: "failed", error: checkoutError(error) });
      },
    );
  }

  /** The folders holding the files found, as `files.watch` names them ("" is the root). */
  #folders(): Set<string> {
    return new Set(this.#state.files.map((file) => folderOf(file.path)));
  }

  /** Whether a change in `folder` can change what the current query finds. */
  #searches(folder: string): boolean {
    if (this.#folders().has(folder)) return true;
    return searchedRoots(this.#state.query).some(
      (root) => !root || folder === root || folder.startsWith(`${root}/`),
    );
  }

  /** Several changes in a row run one refresh, once they pause. */
  #refreshSoon(): void {
    if (this.#state.status !== "done" || this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      if (this.#state.status === "done" && this.#running === undefined) this.#search(true);
    }, searchDelay);
  }

  /** Stop listening for the thread: the search running for it stops too. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#cancel();
    this.#stopListening();
    this.#watch.leave();
  }

  #cancel(): void {
    const running = this.#running;
    this.#running = undefined;
    running?.abort();
  }

  #set(patch: Partial<ContentSearchState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

/** Searches of threads with no Files tab open that are kept, newest last, for a quick return. */
export const idleSearchesKept = 4;

type Registry = {
  stores: Map<string, ContentSearchStore>;
  /** Files tabs open per thread. */
  holders: Map<string, number>;
  /** Threads with no Files tab open, the least recently closed first. */
  idle: string[];
};

const registries = new WeakMap<ClientApi, Registry>();

function registry(client: ClientApi): Registry {
  let found = registries.get(client);
  if (!found) {
    found = { stores: new Map(), holders: new Map(), idle: [] };
    registries.set(client, found);
  }
  return found;
}

/** The thread's search store for this client, made on first use. */
export function contentSearchStore(client: ClientApi, threadId: string): ContentSearchStore {
  const { stores } = registry(client);
  let store = stores.get(threadId);
  if (!store) {
    store = new ContentSearchStore(client, threadId);
    stores.set(threadId, store);
  }
  return store;
}

/**
 * Hold the thread's search while a Files tab of it is open; call the result when the tab closes.
 * Once no tab holds it the search stays for a while, but only the newest few idle ones are kept,
 * so a long session does not keep every searched thread's results.
 */
export function retainContentSearch(client: ClientApi, threadId: string): () => void {
  const held = registry(client);
  held.holders.set(threadId, (held.holders.get(threadId) ?? 0) + 1);
  held.idle = held.idle.filter((id) => id !== threadId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (held.holders.get(threadId) ?? 1) - 1;
    if (count > 0) {
      held.holders.set(threadId, count);
      return;
    }
    held.holders.delete(threadId);
    held.idle.push(threadId);
    while (held.idle.length > idleSearchesKept) {
      const evicted = held.idle.shift();
      if (evicted === undefined) break;
      held.stores.get(evicted)?.dispose();
      held.stores.delete(evicted);
    }
  };
}

export function useContentSearch(store: ContentSearchStore): ContentSearchState {
  return useSyncExternalStore(store.subscribe, () => store.state);
}
