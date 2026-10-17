import { loadThreadSnapshot } from "./thread-snapshot.ts";
import { ThreadReadCache } from "./thread-read-cache.ts";
import { readTurnSteps, stepSurface, type TurnStepsSource } from "./long-thread/steps.ts";
import {
  EntitiesPage,
  TurnsPageRequest,
  ItemsWindowRequest,
  ItemsWindowResponse,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  TurnStepsRequest,
  type TurnStepsRequest as StepsQuery,
  type TurnsPageRequest as TurnsQuery,
  type ItemsWindowRequest as WindowQuery,
  type ThreadSearchRequest as ThreadSearchQuery,
  type ThreadCatchUpRequest as CatchUpQuery,
  type EntityCollection,
  Event,
  Thread,
  ThreadId,
  type ItemId,
  type ThreadView,
} from "@ace/protocol";
import { LongThreadIndex } from "./long-thread/index.ts";
import { HistoryIndex } from "./history-index.ts";
import { readHistoryBlob } from "./history-storage.ts";
import { StatusStore } from "./status-store.ts";
import { PayloadStore } from "./payload-store.ts";
import { SearchIndex } from "@ace/search";
import type { DatabaseSync, StatementSync } from "@ace/provider-kit/sqlite";

/** What the read path needs from the store: the flush barrier and the write-transaction
 *  owner the reads call into, plus the components shared with write code. Components resolve
 *  lazily: the host is built before the store constructor finishes opening them. */
export interface StoreThreadsHost {
  db(): DatabaseSync;
  flushLiveWrites(): void;
  statement(sql: string): StatementSync;
  headSeq(): number;
  atomic<T>(run: (db: DatabaseSync) => T): T;
  inTransaction(): boolean;
  getThread(id: ThreadId): Thread | undefined;
  status(): StatusStore;
  payloads(): PayloadStore;
  longThreads(): LongThreadIndex;
  stepSites(): Map<string, string | null>;
  search(): SearchIndex;
  history(): HistoryIndex;
  onError(error: unknown): void;
}

/** One read-path owner for thread reads: acquire/catch-up identity, the read cache and its
 *  keys, snapshot, entity, item and turn pages, and the committed-batch fan-out that keeps
 *  acquired views current. The store keeps the flush barrier and write-transaction ownership. */
export class ThreadReads {
  readonly readCache: ThreadReadCache;
  private hot: StoreThreadsHost;
  private caches = new Map<ThreadId, { view: ThreadView; refs: number }>();

  constructor(hot: StoreThreadsHost) {
    this.hot = hot;
    this.readCache = new ThreadReadCache({
      flush: () => this.hot.flushLiveWrites(),
      version: () =>
        `${this.hot.statement("PRAGMA data_version").get()?.data_version}:${this.hot.statement("SELECT total_changes() AS n").get()?.n}`,
      inTransaction: () => this.hot.inTransaction(),
      generationChanged: () => {
        for (const { view } of this.caches.values()) this.hot.status().invalidateCache(view);
      },
    });
  }

  applyToAcquiredViews(batch: Event[]): void {
    for (const [id, { view }] of this.caches) {
      const changes = batch.filter(
        (event) =>
          event.seq > view.seq &&
          event.threadId === view.thread.id &&
          !event.payload.type.startsWith("item."),
      );
      try {
        if (changes.length && this.hot.status().cacheInvalidated(view)) this.catchUp(view, id);
        else if (changes.length) this.hot.status().updateCache(view, changes);
        if (!this.hot.status().cacheInvalidated(view))
          view.seq = Math.max(view.seq, batch.at(-1)?.seq ?? view.seq);
      } catch (error) {
        this.caches.delete(id);
        try {
          this.hot.onError(error);
        } catch {
          /* committed delivery must continue */
        }
      }
    }
  }

  clear(): void {
    this.caches.clear();
  }

  discard(id: ThreadId): void {
    this.caches.delete(id);
  }

  acquireThread(id: ThreadId): ThreadView {
    this.hot.flushLiveWrites();
    const cached = this.caches.get(id);
    if (cached) {
      this.catchUp(cached.view, id);
      cached.refs++;
      return cached.view;
    }
    const view = this.hot.status().snapshot(this.hot.getThread(id), this.hot.headSeq());
    this.caches.set(id, { view, refs: 1 });
    return view;
  }

  private catchUp(view: ThreadView, id: ThreadId): void {
    const head = this.hot.headSeq();
    if (view.seq < head || this.hot.status().cacheInvalidated(view)) {
      const thread = this.hot.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      this.hot.status().replaceCache(view, this.hot.status().snapshot(thread, head));
    }
  }

  snapshotThread(id: ThreadId): ThreadView {
    return this.readCache.read(`snapshot:${id}`, () =>
      loadThreadSnapshot({
        acquire: () =>
          this.hot.inTransaction()
            ? this.hot.status().snapshot(this.hot.getThread(id), this.hot.headSeq())
            : this.acquireThread(id),
        release: () => {
          if (!this.hot.inTransaction()) this.releaseThread(id);
        },
        items: () => this.hot.payloads().page(id, this.hot.headSeq() + 1, 200, 1024 * 1024),
        retainAgents: (view) => this.hot.status().retainItemAgents(view),
      }),
    );
  }

  readEntityPage(threadId: ThreadId, collection: EntityCollection, before: number, limit: number) {
    this.hot.flushLiveWrites();
    const thread = this.hot.getThread(threadId);
    if (!thread) throw new Error("Unknown thread");
    return this.readCache.read(
      JSON.stringify(["entities", threadId, collection, before, limit]),
      () =>
        EntitiesPage.parse({
          ...this.hot.status().page(thread, collection, before, limit),
          seq: this.hot.headSeq(),
        }),
    );
  }

  readItems(threadId: ThreadId, before: number, limit: number) {
    this.hot.flushLiveWrites();
    if (!this.hot.getThread(threadId)) throw new Error("Unknown thread");
    return this.readCache.read(JSON.stringify(["items", threadId, before, limit]), () => ({
      ...this.hot.payloads().page(threadId, before, limit),
      seq: this.hot.headSeq(),
    }));
  }

  private readableThread(id: ThreadId): Thread {
    this.hot.flushLiveWrites();
    const thread = this.hot.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    return thread;
  }

  turnsPage(input: Omit<TurnsQuery, "type" | "requestId"> & { requestId?: string }) {
    const query = TurnsPageRequest.parse({ type: "turns.page", requestId: "turns", ...input });
    this.readableThread(query.threadId);
    return this.hot.longThreads().reader.page(query, this.hot.headSeq());
  }

  turnSteps(
    input: Omit<StepsQuery, "type" | "requestId" | "limit"> & {
      requestId?: string;
      limit?: number;
    },
    cachedIcon?: TurnStepsSource["cachedIcon"],
  ) {
    const query = TurnStepsRequest.parse({ type: "turn.steps", requestId: "steps", ...input });
    this.readableThread(query.threadId);
    return readTurnSteps(
      {
        data: this.hot.longThreads().data,
        item: (threadId, itemId) => this.hot.payloads().stepItem(threadId, itemId),
        sites: this.hot.stepSites(),
        cachedIcon,
      },
      query,
      this.hot.headSeq(),
    );
  }

  /** A recorded step's site or app, worked out by the daemon (`icons.resolve`). */
  stepSurface(threadId: ThreadId, itemId: string) {
    this.readableThread(threadId);
    return stepSurface(
      {
        data: this.hot.longThreads().data,
        item: (thread, id) => this.hot.payloads().stepItem(thread, id),
        sites: this.hot.stepSites(),
      },
      threadId,
      itemId,
    );
  }

  itemsWindow(input: Omit<WindowQuery, "type" | "requestId"> & { requestId?: string }) {
    const query = ItemsWindowRequest.parse({ type: "items.window", requestId: "window", ...input });
    this.readableThread(query.threadId);
    let target = query.aroundSeq;
    if (query.itemId !== undefined) {
      target = this.hot.payloads().itemCreatedSeq(query.threadId, query.itemId);
      if (target === undefined)
        return ItemsWindowResponse.parse({
          type: "items.window",
          requestId: query.requestId,
          threadId: query.threadId,
          seq: this.hot.headSeq(),
          targetSeq: null,
          items: [],
          itemSeqs: {},
          itemsBefore: null,
          itemsAfter: null,
        });
    }
    if (query.turnOrdinal !== undefined) {
      const row = this.hot
        .longThreads()
        .data.sql(
          "SELECT MIN(i.created_seq) AS seq FROM long_items i JOIN item_heads h ON h.id=i.item_id AND h.thread_id=i.thread_id WHERE i.thread_id=? AND i.ordinal=?",
        )
        .get(query.threadId, query.turnOrdinal);
      if (row?.seq == null) throw new Error("turn_target_unavailable");
      target = Number(row.seq);
    }
    return ItemsWindowResponse.parse({
      type: "items.window",
      requestId: query.requestId,
      seq: this.hot.headSeq(),
      ...this.hot
        .payloads()
        .window(query.threadId, target ?? 0, query.before, query.after, 1024 * 1024),
    });
  }

  threadSearch(
    input: Omit<ThreadSearchQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    const query = ThreadSearchRequest.parse({
      type: "thread.search",
      requestId: "search",
      ...input,
    });
    this.readableThread(query.threadId);
    const threads =
      query.scope === "tree"
        ? this.hot.longThreads().reader.descendantThreads(query.threadId)
        : [query.threadId];
    if (threads.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
    const response = this.hot.search().threadQuery(query, {
      headSeq: this.hot.headSeq(),
      threadIds: threads,
      turnOrdinalForItem: (thread, item) => this.hot.longThreads().reader.ordinal(thread, item),
    });
    const indexedSeq = Math.min(response.indexedSeq, this.hot.longThreads().data.indexedSeq());
    return { ...response, indexedSeq, ready: response.ready && indexedSeq >= response.headSeq };
  }

  threadCatchUp(
    input: Omit<CatchUpQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    const query = ThreadCatchUpRequest.parse({
      type: "thread.catchUp",
      requestId: "catch-up",
      ...input,
    });
    this.readableThread(query.threadId);
    const family = this.hot.longThreads().reader.descendantThreads(query.threadId);
    if (family.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
    return this.hot.longThreads().reader.catchUp(query, this.hot.headSeq(), family);
  }

  threadReadState(
    threadId: ThreadId,
    deviceId: import("@ace/protocol").DeviceId,
    requestId = "read-state",
  ) {
    this.readableThread(threadId);
    return this.hot.longThreads().reader.readState(threadId, deviceId, requestId);
  }

  outputThread(streamId: string) {
    return this.hot.payloads().liveStreamThread(streamId);
  }

  readItemPage(threadId: ThreadId, before: number, limit: number, byteLimit = 1024 * 1024) {
    this.hot.flushLiveWrites();
    if (!this.hot.getThread(threadId)) throw new Error("Unknown thread");
    return this.readCache.read(
      JSON.stringify(["wireItems", threadId, before, limit, byteLimit]),
      () => ({
        ...this.hot.payloads().wirePage(threadId, before, limit, byteLimit),
        seq: this.hot.headSeq(),
      }),
    );
  }

  readRawChunk(blobRef: string, offset: number, limit: number): Uint8Array {
    return this.hot.payloads().streamed.read(blobRef, offset, limit);
  }

  historicalItemCount(threadId: ThreadId, through: number): number {
    this.hot.flushLiveWrites();
    return this.hot.history().count(threadId, through);
  }

  historicalItemCompletion(threadId: ThreadId, itemId: ItemId) {
    this.hot.flushLiveWrites();
    return this.hot.history().completion(threadId, itemId);
  }

  readHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit = 1024 * 1024,
  ) {
    this.hot.flushLiveWrites();
    if (!this.hot.getThread(threadId)) throw new Error("Unknown thread");
    return this.hot.history().page(threadId, through, before, limit, byteLimit);
  }

  readHistoricalStream(
    threadId: ThreadId,
    streamId: string,
    through: number,
    offset: number,
    limit: number,
  ) {
    this.hot.flushLiveWrites();
    return this.hot.history().readStream(threadId, streamId, through, offset, limit);
  }

  blobInfo(blobRef: string) {
    return this.hot.payloads().blobInfo(blobRef);
  }

  outputInfo(streamId: string) {
    this.hot.flushLiveWrites();
    return this.hot.payloads().outputInfo(streamId);
  }

  readOutputBytes(streamId: string, offset: number, limit: number) {
    this.hot.flushLiveWrites();
    return this.hot.payloads().readLiveOutputBytes(streamId, offset, limit);
  }

  readOutput(streamId: string, offset: number, limit: number) {
    this.hot.flushLiveWrites();
    return this.hot.payloads().readOutput(streamId, offset, limit);
  }

  readHistoryBlob(threadId: ThreadId, id: string, offset: number, limit: number) {
    if (!this.hot.getThread(threadId)) throw new Error("Unknown thread");
    return readHistoryBlob(this.hot.db(), threadId, id, offset, limit);
  }

  releaseThread(id: ThreadId): void {
    const cached = this.caches.get(id);
    if (cached && --cached.refs === 0) this.caches.delete(id);
  }
}
