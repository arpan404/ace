import type { ClientCore } from "@ace/client";
import { FileSearchSummary, ThreadId, type FileSearchFile } from "@ace/protocol";
import {
  CheckoutError,
  checkoutError,
  contentSearchOperation,
  emptyContentQuery,
  lineHit,
  matchCount,
  mergeSearchBatch,
  nothingFound,
  previewParts,
  searchFailure,
  searchTally,
  truncatedNote,
  type ContentQuery,
  type SearchFound,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { Timers } from "./kept-read.ts";

/*
 * Search in file contents for the Files screen's Contents scope: the web's Search view, with the
 * query, merge and preview rules shared through ui-core. Every change of the query stops the
 * search before it at once (the client sends `files.abort`, so the daemon stops walking) and
 * empties the list, and the new one starts once typing pauses. Matches stream in as
 * `files.search.matches` and each change answers with the thread's `files.contents` patch, its
 * rows built when the pump pulls it. A thread's results stay while its screen pushes a file, so
 * coming back shows the same list; only the newest few threads' results are kept.
 */

/** How long typing pauses before the search runs. */
export const contentSearchDelay = 250;
/** A search the daemon is still walking after this long is given up on. */
const searchTimeoutMs = 5 * 60_000;
/** Threads whose last results are kept, the most recently searched last. */
const searchesKept = 3;

const Query = z.object({
  pattern: z.string().max(1000),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
});

export const NativeContentSearchAction = z.discriminatedUnion("type", [
  /** The query changed: stop the running search and start this one once typing pauses. */
  z.object({
    type: z.literal("files.contents.search"),
    threadId: ThreadId,
    query: Query,
    /** Search at once (Return, or Try again) instead of waiting for typing to pause. */
    now: z.boolean().default(false),
  }),
  /** The search field was cleared or left the Contents scope: stop and forget the results. */
  z.object({ type: z.literal("files.contents.stop"), threadId: ThreadId }),
]);
export type NativeContentSearchAction = z.infer<typeof NativeContentSearchAction>;

export type SearchOwner = Pick<ClientCore, "request" | "onMessage">;

interface SearchState {
  threadId: string;
  query: ContentQuery;
  status: "idle" | "searching" | "done" | "failed";
  found: SearchFound;
  truncated: boolean;
  error: CheckoutError | undefined;
  timer: (() => void) | undefined;
  running: AbortController | undefined;
}

/** One part of a shown preview line. */
export interface ContentPart {
  text: string;
  match: boolean;
}
/** A matching line as the screen draws it, with where its first match opens. */
export interface ContentLineRow {
  key: string;
  line: number;
  column: number;
  length: number;
  parts: ContentPart[];
}
export interface ContentFileRow {
  path: string;
  name: string;
  folder: string;
  count: number;
  lines: ContentLineRow[];
}

/** Rows already built, by the file batch they came from: a merge keeps unchanged files. */
const built = new WeakMap<FileSearchFile, ContentFileRow>();

/** The rows of a file: its name, folder, count and lines trimmed so the first match shows. */
export function contentFileRow(file: FileSearchFile): ContentFileRow {
  const known = built.get(file);
  if (known) return known;
  const row = fileRow(file);
  built.set(file, row);
  return row;
}

function fileRow(file: FileSearchFile): ContentFileRow {
  const slash = file.path.lastIndexOf("/");
  return {
    path: file.path,
    name: file.path.slice(slash + 1),
    folder: slash > 0 ? file.path.slice(0, slash) : "",
    count: matchCount(file),
    lines: file.lines.map((line) => {
      const hit = lineHit(file.path, line);
      return {
        key: `${file.path}:${line.line}`,
        line: line.line,
        column: hit.column,
        length: hit.length,
        parts: previewParts(line.preview, line.ranges, line.column > 0).map((part) => ({
          text: part.text,
          match: part.match,
        })),
      };
    }),
  };
}

export class CheckoutContentSearch {
  readonly #owner: SearchOwner;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #timers: Timers;
  readonly #id: () => string;
  /** By thread, the most recently searched last. */
  readonly #searches = new Map<string, SearchState>();

  constructor(owner: SearchOwner, sink: Pick<PatchSink, "put">, timers: Timers, id: () => string) {
    this.#owner = owner;
    this.#sink = sink;
    this.#timers = timers;
    this.#id = id;
  }

  handle(action: NativeContentSearchAction): void {
    if (action.type === "files.contents.stop") {
      const state = this.#searches.get(action.threadId);
      if (!state) return;
      this.#cancel(state);
      this.#searches.delete(action.threadId);
      state.query = emptyContentQuery;
      state.status = "idle";
      state.found = nothingFound;
      state.truncated = false;
      state.error = undefined;
      this.#emit(state);
      return;
    }
    const state = this.#state(action.threadId);
    this.#cancel(state);
    state.query = { ...emptyContentQuery, ...action.query };
    state.status = state.query.pattern ? "searching" : "idle";
    state.found = nothingFound;
    state.truncated = false;
    state.error = undefined;
    this.#emit(state);
    if (!state.query.pattern) return;
    if (action.now) this.#run(state);
    else state.timer = this.#timers.set(contentSearchDelay, () => this.#run(state));
  }

  /** The thread's state, kept as the newest; the oldest past the limit stops and is dropped. */
  #state(threadId: string): SearchState {
    let state = this.#searches.get(threadId);
    if (state) this.#searches.delete(threadId);
    else
      state = {
        threadId,
        query: emptyContentQuery,
        status: "idle",
        found: nothingFound,
        truncated: false,
        error: undefined,
        timer: undefined,
        running: undefined,
      };
    this.#searches.set(threadId, state);
    for (const [id, old] of this.#searches) {
      if (this.#searches.size <= searchesKept) break;
      this.#cancel(old);
      this.#searches.delete(id);
    }
    return state;
  }

  #run(state: SearchState): void {
    state.timer = undefined;
    const controller = new AbortController();
    state.running = controller;
    const requestId = `search-${this.#id()}`;
    const current = () => state.running === controller;
    const stop = this.#owner.onMessage((message) => {
      if (message.type !== "files.search.matches" || message.searchId !== requestId) return;
      if (!current()) return;
      state.found = mergeSearchBatch(state.found, message.files);
      this.#emit(state);
    });
    void this.#owner
      .request(
        {
          type: "files.request",
          threadId: ThreadId.parse(state.threadId),
          operation: contentSearchOperation(state.query),
        },
        { requestId, signal: controller.signal, timeoutMs: searchTimeoutMs },
      )
      .then((reply) => {
        if (!current()) return;
        if (reply.type === "files.error") throw searchFailure(reply.code);
        const summary =
          reply.type === "files.result" ? FileSearchSummary.safeParse(reply.value) : undefined;
        if (!summary?.success)
          throw new CheckoutError("protocol", "Couldn't read the search results. Update ace.");
        state.running = undefined;
        state.status = "done";
        state.truncated = summary.data.truncated;
        this.#emit(state);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        state.running = undefined;
        state.status = "failed";
        state.error = checkoutError(error);
        this.#emit(state);
      })
      .finally(stop);
  }

  #cancel(state: SearchState): void {
    state.timer?.();
    state.timer = undefined;
    const running = state.running;
    state.running = undefined;
    running?.abort();
  }

  /** The list the screen draws, built when the pump pulls the patch. */
  #emit(state: SearchState): void {
    const { threadId, query, status, found, truncated, error } = state;
    this.#sink.put(`files.contents:${threadId}`, () => ({
      type: "files.contents",
      threadId,
      query: {
        pattern: query.pattern,
        matchCase: query.matchCase,
        wholeWord: query.wholeWord,
        regex: query.regex,
      },
      status,
      tally: found.matches ? searchTally(found.matches, found.files.length) : null,
      note: truncated ? truncatedNote(found.matches) : null,
      error: error?.message ?? null,
      files: found.files.map(contentFileRow),
    }));
  }
}
