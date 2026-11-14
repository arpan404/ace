import type { DatabaseSync } from "node:sqlite";
import type {
  EntitiesPage,
  EntityCollection,
  Event,
  ItemId,
  Thread,
  ThreadId,
  ThreadView,
} from "@ace/protocol";
import type { PayloadStore } from "./payload-store.ts";
import type { HistoryIndex } from "./history-index.ts";
import type { StatusStore } from "./status-store.ts";
import type { ThreadReadCache } from "./thread-read-cache.ts";
import { loadThreadSnapshot } from "./thread-snapshot.ts";
import type { FrozenThread } from "./thread-cache.ts";
import { readHistoryBlob } from "./history-storage.ts";
import { boundedItemPage } from "./bounded-item-page.ts";

interface ThreadReadSource {
  db: DatabaseSync;
  cache: ThreadReadCache;
  payloads: PayloadStore;
  history: HistoryIndex;
  status: StatusStore;
  flush(): void;
  headSeq(): number;
  getThread(id: ThreadId): Thread | undefined;
  /** The shared frozen thread, for reads that only look (no copy). */
  readThread(id: ThreadId): FrozenThread | undefined;
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
  /**
   * Held views follow committed data only. A batch published while a transaction is open (a
   * live buffer's pending deltas) could be read against rows that may still roll back, so it
   * only marks the views it changes stale: each is rebuilt at its next read outside it.
   */
  updateViews(batch: Event[]): void {
    const open = this.source.inTransaction();
    for (const [id, { view }] of this.caches) {
      const changes = batch.filter(
        (event) =>
          event.seq > view.seq &&
          event.threadId === view.thread.id &&
          !event.payload.type.startsWith("item."),
      );
      if (open) {
        if (changes.length) this.source.status.invalidateCache(view);
        continue;
      }
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
  /**
   * The held view, kept current with committed data. Inside an open transaction (the store's
   * or one begun on the connection) the caller gets a private view of what that transaction
   * sees, and the held one is left as committed: whatever the transaction's ending, commit,
   * rollback or abandonment, no held view ever shows rows it did not commit. The lease counts
   * the same either way.
   */
  acquireThread(id: ThreadId): ThreadView {
    this.source.flush();
    const cached = this.caches.get(id);
    if (this.source.inTransaction()) {
      const view = this.source.status.snapshot(this.source.getThread(id), this.source.headSeq());
      if (cached) cached.refs++;
      else {
        // Built from rows that may roll back: held only as stale, rebuilt at its next read.
        const held = structuredClone(view);
        this.source.status.invalidateCache(held);
        this.caches.set(id, { view: held, refs: 1 });
      }
      return view;
    }
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
  /**
   * The thread's contents are shared and frozen (a snapshot is only encoded and sent); the
   * top level is the caller's own and carries the current head, as a fresh read would: a
   * cached snapshot describes the thread through now, since any write to it evicts the entry.
   */
  snapshotThread(id: ThreadId): ThreadView {
    const view = this.sharedSnapshot(id);
    return { ...view, seq: this.source.headSeq() };
  }
  private sharedSnapshot(id: ThreadId): ThreadView {
    return this.source.cache.readShared(id, "snapshot", () =>
      loadThreadSnapshot({
        acquire: () =>
          this.source.inTransaction()
            ? this.source.status.snapshot(this.source.getThread(id), this.source.headSeq())
            : this.acquireThread(id),
        release: () => {
          if (!this.source.inTransaction()) this.releaseThread(id);
        },
        items: (status) =>
          this.source.payloads.tail(id, status.thread.rootAgentId, 200, 1024 * 1024),
        retainAgents: (view) => this.source.status.retainItemAgents(view),
      }),
    );
  }
  readEntityPage(
    threadId: ThreadId,
    collection: EntityCollection,
    before: number,
    limit: number,
  ): EntitiesPage {
    this.source.flush();
    const thread = this.source.readThread(threadId);
    if (!thread) throw new Error("Unknown thread");
    // Built here from entity rows read in this build's shape (`entity-shape.ts`): not parsed again.
    return this.current(
      this.source.cache.read(
        threadId,
        JSON.stringify(["entities", collection, before, limit]),
        (): EntitiesPage => ({
          ...this.source.status.page(thread, collection, before, limit),
          seq: this.source.headSeq(),
        }),
      ),
    );
  }
  getInteraction(id: string) {
    return this.source.status.interaction(id);
  }
  readItems(threadId: ThreadId, before: number, limit: number) {
    this.source.flush();
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    return this.current(
      this.source.cache.read(threadId, JSON.stringify(["items", before, limit]), () => ({
        ...this.source.payloads.page(threadId, before, limit),
        seq: this.source.headSeq(),
      })),
    );
  }
  outputThread(streamId: string) {
    return this.source.payloads.liveStreamThread(streamId);
  }
  readItemPage(threadId: ThreadId, before: number, limit: number, byteLimit = 1024 * 1024) {
    this.source.flush();
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    return this.current(
      this.source.cache.read(
        threadId,
        JSON.stringify(["wireItems", before, limit, byteLimit]),
        () => ({
          ...this.source.payloads.wirePage(threadId, before, limit, byteLimit),
          seq: this.source.headSeq(),
        }),
      ),
    );
  }
  /** `readItemPage` for agents and previews: one oversized item never fails the page. */
  readBoundedItemPage(threadId: ThreadId, before: number, limit: number, byteLimit: number) {
    this.source.flush();
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    const payloads = this.source.payloads;
    return this.current(
      this.source.cache.read(
        threadId,
        JSON.stringify(["boundedItems", before, limit, byteLimit]),
        () => ({
          ...boundedItemPage(
            {
              page: (from, count, bytes) => payloads.wirePage(threadId, from, count, bytes),
              newestBefore: (from) => payloads.newestBefore(threadId, from),
              hasItemBefore: (from) => payloads.hasItemBefore(threadId, from),
            },
            threadId,
            before,
            limit,
            byteLimit,
          ),
          seq: this.source.headSeq(),
        }),
      ),
    );
  }
  /**
   * A cached page is the thread as of now: any write to the thread since it was read evicted
   * it. So it carries the current head, as a fresh read would.
   */
  private current<T extends { seq: number }>(page: T): T {
    page.seq = this.source.headSeq();
    return page;
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
  historicalOpening(threadId: ThreadId, through: number) {
    this.source.flush();
    return this.source.history.opening(threadId, through);
  }
  readHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit = 1024 * 1024,
  ) {
    this.source.flush();
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    return this.source.history.page(threadId, through, before, limit, byteLimit);
  }
  /** `readHistoricalItemPage` for agents: one oversized item never fails the page. */
  readBoundedHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit: number,
  ) {
    this.source.flush();
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    const history = this.source.history;
    return boundedItemPage(
      {
        page: (from, count, bytes) => history.page(threadId, through, from, count, bytes),
        newestBefore: (from) => history.newestBefore(threadId, through, from),
        hasItemBefore: (from) => history.hasItemBefore(threadId, through, from),
      },
      threadId,
      before,
      limit,
      byteLimit,
    );
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
    if (!this.source.readThread(threadId)) throw new Error("Unknown thread");
    return readHistoryBlob(this.source.db, threadId, id, offset, limit);
  }
  /** Threads a reader holds open right now, such as a client's thread subscription. */
  heldThreads(): ThreadId[] {
    return [...this.caches.keys()];
  }
  releaseThread(id: ThreadId): void {
    const cached = this.caches.get(id);
    if (cached && --cached.refs === 0) this.caches.delete(id);
  }
}
