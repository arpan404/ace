import type { DatabaseSync } from "node:sqlite";
import type { EntityCollection, Event, ItemId, Thread, ThreadId, ThreadView } from "@ace/protocol";
import { EntitiesPage } from "@ace/protocol";
import type { PayloadStore } from "./payload-store.ts";
import type { HistoryIndex } from "./history-index.ts";
import type { StatusStore } from "./status-store.ts";
import type { ThreadReadCache } from "./thread-read-cache.ts";
import { loadThreadSnapshot } from "./thread-snapshot.ts";
import { readHistoryBlob } from "./history-storage.ts";

interface ThreadReadSource {
  db: DatabaseSync;
  cache: ThreadReadCache;
  payloads: PayloadStore;
  history: HistoryIndex;
  status: StatusStore;
  flush(): void;
  headSeq(): number;
  getThread(id: ThreadId): Thread | undefined;
  inTransaction(): boolean;
  report(error: unknown): void;
}

/** Detached reads and acquired status leases share one generation-fenced read path. */
export class ThreadReads {
  private readonly source: ThreadReadSource;
  private readonly caches = new Map<ThreadId, { view: ThreadView; refs: number }>();
  constructor(source: ThreadReadSource) {
    this.source = source;
  }
  invalidateViews(): void {
    for (const { view } of this.caches.values()) this.source.status.invalidateCache(view);
  }
  clearViews(): void {
    this.caches.clear();
  }
  forget(id: ThreadId): void {
    this.caches.delete(id);
  }
  updateViews(batch: Event[]): void {
    for (const [id, { view }] of this.caches) {
      const changes = batch.filter(
        (event) =>
          event.seq > view.seq &&
          event.threadId === view.thread.id &&
          !event.payload.type.startsWith("item."),
      );
      try {
        if (changes.length && this.source.status.cacheInvalidated(view)) this.catchUp(view, id);
        else if (changes.length) this.source.status.updateCache(view, changes);
        if (!this.source.status.cacheInvalidated(view))
          view.seq = Math.max(view.seq, batch.at(-1)?.seq ?? view.seq);
      } catch (error) {
        this.caches.delete(id);
        try {
          this.source.report(error);
        } catch {
          /* Committed delivery must continue. */
        }
      }
    }
  }
  acquireThread(id: ThreadId): ThreadView {
    this.source.flush();
    const cached = this.caches.get(id);
    if (cached) {
      this.catchUp(cached.view, id);
      cached.refs++;
      return cached.view;
    }
    const view = this.source.status.snapshot(this.source.getThread(id), this.source.headSeq());
    this.caches.set(id, { view, refs: 1 });
    return view;
  }
  private catchUp(view: ThreadView, id: ThreadId): void {
    const head = this.source.headSeq();
    if (view.seq < head || this.source.status.cacheInvalidated(view)) {
      const thread = this.source.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      this.source.status.replaceCache(view, this.source.status.snapshot(thread, head));
    }
  }
  snapshotThread(id: ThreadId): ThreadView {
    return this.source.cache.read(`snapshot:${id}`, () =>
      loadThreadSnapshot({
        acquire: () =>
          this.source.inTransaction()
            ? this.source.status.snapshot(this.source.getThread(id), this.source.headSeq())
            : this.acquireThread(id),
        release: () => {
          if (!this.source.inTransaction()) this.releaseThread(id);
        },
        items: () => this.source.payloads.page(id, this.source.headSeq() + 1, 200, 1024 * 1024),
        retainAgents: (view) => this.source.status.retainItemAgents(view),
      }),
    );
  }
  readEntityPage(threadId: ThreadId, collection: EntityCollection, before: number, limit: number) {
    this.source.flush();
    const thread = this.source.getThread(threadId);
    if (!thread) throw new Error("Unknown thread");
    return this.source.cache.read(
      JSON.stringify(["entities", threadId, collection, before, limit]),
      () =>
        EntitiesPage.parse({
          ...this.source.status.page(thread, collection, before, limit),
          seq: this.source.headSeq(),
        }),
    );
  }
  getInteraction(id: string) {
    return this.source.status.interaction(id);
  }
  readItems(threadId: ThreadId, before: number, limit: number) {
    this.source.flush();
    if (!this.source.getThread(threadId)) throw new Error("Unknown thread");
    return this.source.cache.read(JSON.stringify(["items", threadId, before, limit]), () => ({
      ...this.source.payloads.page(threadId, before, limit),
      seq: this.source.headSeq(),
    }));
  }
  outputThread(streamId: string) {
    return this.source.payloads.liveStreamThread(streamId);
  }
  readItemPage(threadId: ThreadId, before: number, limit: number, byteLimit = 1024 * 1024) {
    this.source.flush();
    if (!this.source.getThread(threadId)) throw new Error("Unknown thread");
    return this.source.cache.read(
      JSON.stringify(["wireItems", threadId, before, limit, byteLimit]),
      () => ({
        ...this.source.payloads.wirePage(threadId, before, limit, byteLimit),
        seq: this.source.headSeq(),
      }),
    );
  }
  readRawChunk(blobRef: string, offset: number, limit: number): Uint8Array {
    return this.source.payloads.streamed.read(blobRef, offset, limit);
  }
  historicalItemCount(threadId: ThreadId, through: number): number {
    this.source.flush();
    return this.source.history.count(threadId, through);
  }
  historicalItemCompletion(threadId: ThreadId, itemId: ItemId) {
    this.source.flush();
    return this.source.history.completion(threadId, itemId);
  }
  readHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit = 1024 * 1024,
  ) {
    this.source.flush();
    if (!this.source.getThread(threadId)) throw new Error("Unknown thread");
    return this.source.history.page(threadId, through, before, limit, byteLimit);
  }
  readHistoricalStream(
    threadId: ThreadId,
    streamId: string,
    through: number,
    offset: number,
    limit: number,
  ) {
    this.source.flush();
    return this.source.history.readStream(threadId, streamId, through, offset, limit);
  }
  blobInfo(blobRef: string) {
    return this.source.payloads.blobInfo(blobRef);
  }
  outputInfo(streamId: string) {
    this.source.flush();
    return this.source.payloads.outputInfo(streamId);
  }
  readOutputBytes(streamId: string, offset: number, limit: number) {
    this.source.flush();
    return this.source.payloads.readLiveOutputBytes(streamId, offset, limit);
  }
  readOutput(streamId: string, offset: number, limit: number) {
    this.source.flush();
    return this.source.payloads.readOutput(streamId, offset, limit);
  }
  readHistoryBlob(threadId: ThreadId, id: string, offset: number, limit: number) {
    if (!this.source.getThread(threadId)) throw new Error("Unknown thread");
    return readHistoryBlob(this.source.db, threadId, id, offset, limit);
  }
  releaseThread(id: ThreadId): void {
    const cached = this.caches.get(id);
    if (cached && --cached.refs === 0) this.caches.delete(id);
  }
}
