import { ThreadReads } from "./thread-reads.ts";
import { LongThreadQueries } from "./long-thread/queries.ts";
import { SidebarReads } from "./sidebar-reads.ts";
import { CommandReceipts } from "./command-receipts.ts";
import { EventWriter } from "./event-writer.ts";
import { decodeThreadRow } from "./thread-row.ts";
import { StreamSequences } from "./stream-sequences.ts";
import { StoreStream, type TransactionOutcome } from "./store-stream.ts";
import { closeStore } from "./store-shutdown.ts";
import { ThreadReadCache } from "./thread-read-cache.ts";
import { WalMaintenance } from "./wal-maintenance.ts";
import {
  bufferScheduler,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";
import { purgeTranscript } from "./storage/transcript.ts";
import { SearchReplay } from "./search-replay.ts";
import { migrateSidebarRevisions } from "./sidebar-revisions.ts";
import { seedSentMessages } from "./draft-migration.ts";
import { mapRecordedPermissionModes } from "./permission-mode-migration.ts";
import { indexEngineRecords } from "./engine-record-indexes.ts";
import { indexThreadRows } from "./thread-row-indexes.ts";
import { timeOrderedIds } from "./time-ordered-id.ts";
import { NativeImageStore } from "./native-image-store.ts";
import { ToolResultStore } from "./tool-result-store.ts";
import { MeasurementStore } from "./measurement-store.ts";
import { migrateProjects, decodeProjectRow } from "./project-storage.ts";
import { LongThreadIndex } from "./long-thread/index.ts";
import { type TurnStepsSource } from "./long-thread/steps.ts";
import {
  type TurnStepsRequest as StepsQuery,
  type TurnsPageRequest as TurnsQuery,
  type ItemsWindowRequest as WindowQuery,
  type ThreadSearchRequest as ThreadSearchQuery,
  type ThreadCatchUpRequest as CatchUpQuery,
} from "@ace/protocol";
import { WorkspaceReservations } from "./workspace-reservations.ts";
import { migrateRunClient } from "./run-client-storage.ts";
import { executionWorkspace } from "./workspace-root.ts";
import { migrateThreadClient, seedThreadClient } from "./thread-client-storage.ts";
import { HistoryIndex } from "./history-index.ts";
import { setImmediate } from "node:timers/promises";
import type { ArchiveReader } from "@ace/history-import";
import { installArchive } from "./history-storage.ts";
import { systemCredentials, type CredentialRuntime } from "./credential-runtime.ts";
import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import {
  McpIntent,
  CommandResult,
  Event,
  Thread,
  DeviceId,
  type CommandId,
  type EventPayload,
  type RawPayload,
  ThreadId,
  type ItemId,
  type ThreadView,
  WorkspaceId,
  WorkspaceFileChange,
} from "@ace/protocol";
import { McpData } from "./mcp-data.ts";
import { Devices } from "./devices.ts";
import { SqlitePairingCodes } from "./pairing-codes.ts";
import { migrate } from "./migrations.ts";
import { StatusStore } from "./status-store.ts";
import { UsageReplay } from "./usage-replay.ts";
import { PayloadStore } from "./payload-store.ts";

import { SearchIndex, SearchQueries, type SearchWorkerFactory } from "@ace/search";
import { createSearchMaintenance, scheduleSearch, type SearchScheduler } from "./search-runtime.ts";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";
import { StoreWriteGate, type StoreWriteGateOptions } from "./store-write-gate.ts";

export interface StoreOptions extends Partial<CredentialRuntime> {
  /** Store owns and closes this SQLite connection when supplied. */
  database?: DatabaseSync;
  nextId?: () => string;
  now?: () => number;
  searchScheduler?: SearchScheduler;
  searchWorkerFactory?: SearchWorkerFactory;
  writeGate?: StoreWriteGateOptions;
  bufferScheduler?: BufferScheduler;
}
type Listener = (events: Event[]) => void;
/** Passes of the search writer (100 ms apart by default) between refreshes of streaming items. */
const streamingRefreshPasses = 20;
export class Store {
  readonly devices: Devices;
  /** Pairing links waiting to be redeemed; they outlive a restart until they expire. */
  readonly pairingCodes: SqlitePairingCodes;
  readonly workspaceReservations: WorkspaceReservations;
  private readonly db: DatabaseSync;
  private readonly usageReplay: UsageReplay;
  private readonly searchReplay: SearchReplay;
  private readonly usageListeners = new Set<() => void>();
  readonly search: SearchIndex;
  readonly searchQueries: SearchQueries;
  private readonly searchAbort = new AbortController();
  private readonly searchMaintenance: ReturnType<typeof createSearchMaintenance>;
  private closing: Promise<void> | undefined;
  private readonly payloads: PayloadStore;
  readonly measurements: MeasurementStore;
  readonly toolResults: ToolResultStore;
  readonly nativeImages: NativeImageStore;
  private readonly history: HistoryIndex;
  private readonly status: StatusStore;
  private readonly longThreads: LongThreadIndex;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private readonly mcp: McpData;
  private engineSessionsKnown = false;
  private statements = new BoundedCache<string, StatementSync>(256, 256);
  private transactionEvents: Event[] | undefined;
  private settlements: { at: number; outcome: TransactionOutcome }[] = [];
  private readonly quarantineListeners = new Set<(thread: ThreadId, error: Error) => void>();
  private rolledBack = 0;
  private readonly streaming: StoreStream;
  private readonly sequences: StreamSequences;
  private readonly readCache: ThreadReadCache;
  private readonly wal: WalMaintenance;
  private transactions = 0;
  private eventRows = 0;
  private depth = 0;
  private installingHistory = false;
  private historyWriting = false;
  private historyWriter: (() => void) | undefined;
  private readonly writes: StoreWriteGate;
  private listeners = new Set<Listener>();
  private readonly threadReads: ThreadReads;
  private readonly navigation: LongThreadQueries;
  private readonly sidebarReads: SidebarReads;
  private sidebarSnapshotSeq = 0;
  private readonly receipts: CommandReceipts;
  private readonly eventWriter: EventWriter;
  private publications: Event[][] = [];
  private deferredAfter: number | undefined;
  private notifyingHistory = false;
  private publishing = false;
  private publishedSeq = 0;
  constructor(
    path: string,
    onError: (error: unknown) => void = console.error,
    options: StoreOptions = {},
  ) {
    this.onError = onError;
    this.db = options.database ?? new DatabaseSync(path);
    this.wal = new WalMaintenance({
      path,
      scheduler: options.bufferScheduler ?? bufferScheduler,
      busy: () =>
        !!this.transactionEvents || this.historyWriting || this.streaming.buffer.bytes > 0,
      exec: (sql) => this.db.exec(sql),
      report: (error) => this.onError(error),
    });
    this.readCache = new ThreadReadCache({
      flush: () => this.flushLiveWrites(),
      version: () =>
        `${this.statement("PRAGMA data_version").get()?.data_version}:${this.statement("SELECT total_changes() AS n").get()?.n}`,
      inTransaction: () => this.transactionEvents !== undefined,
      generationChanged: () => this.threadReads.invalidateViews(),
    });
    this.sidebarReads = new SidebarReads({
      statement: (sql) => this.statement(sql),
      snapshot: (read) => this.sidebarSnapshot(read),
    });
    this.receipts = new CommandReceipts({
      statement: (sql) => this.statement(sql),
      atomic: (run) => this.atomic(run),
      now: () => this.now(),
    });
    this.sequences = new StreamSequences({
      statement: (sql) => this.statement(sql),
      commit: (run) => this.atomic(run),
    });
    this.now = options.now ?? Date.now;
    this.nextId = options.nextId ?? timeOrderedIds();
    this.writes = new StoreWriteGate(options.writeGate);
    this.streaming = new StoreStream({
      scheduler: options.bufferScheduler ?? bufferScheduler,
      nextId: this.nextId,
      sequences: this.sequences,
      blocked: () => this.writes.isHeld() || this.historyWriting,
      transaction: (run, outcome) => this.transaction(run, outcome),
      persist: (event) => this.appendEventBatch(event.threadId, [event.payload], event.at, [event]),
      append: (event) => this.appendEventBatch(event.threadId, [event.payload], event.at),
      stored: (event) =>
        this.statement("SELECT 1 FROM events WHERE seq=? AND id=?").get(event.seq, event.id) !==
        undefined,
      publish: (events) => this.publish(events),
      report: (error) => this.onError(error),
      quarantined: (thread, error) => this.quarantine(thread, error),
    });
    this.payloads = new PayloadStore(this.db, this.nextId, (sql) => this.statement(sql));
    this.status = new StatusStore(this.db, (sql) => this.statement(sql));
    try {
      this.db.exec(
        // auto_vacuum only takes effect before a new file's first page or through VACUUM.
        "PRAGMA auto_vacuum=INCREMENTAL; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;",
      );
      migrate(this.db);
      this.sequences.initialize();
      migrateSidebarRevisions(this.db);
      migrateProjects(this.db);
      this.workspaceReservations = new WorkspaceReservations(this.db, (sql) => this.statement(sql));
      this.atomic(migrateThreadClient);
      this.atomic(mapRecordedPermissionModes);
      this.atomic(indexEngineRecords);
      this.usageReplay = new UsageReplay(this.db);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS threads_update_blockers ON threads(id) WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed')`,
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_live ON threads(workspace_id, archived_at, id)",
      );
      this.payloads.initialize();
      this.nativeImages = new NativeImageStore(this.db, (sql) => this.statement(sql));
      this.toolResults = new ToolResultStore(this.db, (sql) => this.statement(sql));
      this.measurements = new MeasurementStore(this.db, (sql) => this.statement(sql));
      this.atomic(indexThreadRows);
      this.history = new HistoryIndex(
        this.db,
        (sql) => this.statement(sql),
        (stream, offset, limit) => this.payloads.readOutputBytes(stream, offset, limit),
        (thread, item, stream, offset, text) =>
          this.payloads.archiveOutput(thread, item, stream, offset, text),
      );
      this.history.initialize();
      this.status.initialize((id) => this.getThread(id));
      this.threadReads = new ThreadReads({
        db: this.db,
        cache: this.readCache,
        payloads: this.payloads,
        history: this.history,
        status: this.status,
        flush: () => this.flushLiveWrites(),
        headSeq: () => this.headSeq(),
        getThread: (id) => this.getThread(id),
        inTransaction: () => this.transactionEvents !== undefined,
        report: (error) => this.onError(error),
      });
      this.atomic(migrateRunClient);
      this.longThreads = new LongThreadIndex(this.db, (id) => {
        const thread = this.getThread(ThreadId.parse(id));
        return thread?.deletedAt === undefined ? thread : undefined;
      });
      this.atomic((db) => seedThreadClient(db, (id) => this.getThread(id)));
      this.atomic(seedSentMessages);
      this.devices = new Devices(this.db, {
        id: options.id ?? this.nextId,
        randomBytes: options.randomBytes ?? systemCredentials.randomBytes,
      });
      this.pairingCodes = new SqlitePairingCodes(this.db);
      this.mcp = new McpData(this.db, (id) => this.getThread(id));
      this.searchReplay = new SearchReplay(this.db, this.history);
      this.search = new SearchIndex(this.db, {
        readOutput: (threadId, streamId, offset, limit) => {
          const replay = this.history.readSearchBytes(threadId, streamId, offset, limit);
          if (replay) return replay;
          if (this.payloads.streamThread(streamId) !== threadId) return undefined;
          return this.payloads.readOutputBytes(streamId, offset, limit).bytes;
        },
      });
      this.searchQueries = new SearchQueries(path, options.searchWorkerFactory);
      let passes = 0;
      this.searchMaintenance = createSearchMaintenance(
        options.searchScheduler ?? scheduleSearch,
        () => {
          if (this.historyWriting) return;
          try {
            // Finished items publish on every pass. An item still streaming would otherwise
            // rewrite its search documents on every pass while its agent writes; it refreshes
            // once every `streamingRefreshPasses` instead.
            if (++passes % streamingRefreshPasses === 0) this.search.flush();
            else this.search.flushCompleted();
          } catch (error) {
            try {
              this.onError(error);
            } catch {
              /* Pending work retries on the next scheduled pass. */
            }
          }
        },
        () => this.historyWriting || this.search.hasPendingWrites(),
      );
      this.navigation = new LongThreadQueries({
        index: this.longThreads,
        payloads: this.payloads,
        search: this.search,
        getThread: (id) => this.getThread(id),
        flush: () => this.flushLiveWrites(),
        headSeq: () => this.headSeq(),
        now: () => this.now(),
        atomic: (run) => this.atomic(run),
      });
      this.eventWriter = new EventWriter({
        db: this.db,
        sequences: this.sequences,
        payloads: this.payloads,
        history: this.history,
        status: this.status,
        longThreads: this.longThreads,
        mcp: this.mcp,
        search: this.search,
        toolResults: this.toolResults,
        nativeImages: this.nativeImages,
        measurements: this.measurements,
        statement: (sql) => this.statement(sql),
        getThread: (id) => this.getThread(id),
        nextId: this.nextId,
        wakeSearch: () => this.searchMaintenance.wake(),
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    // Existing history is already covered by new subscribers' initial snapshots.
    this.publishedSeq = this.headSeq();
    void this.search
      .backfill(this, { signal: this.searchAbort.signal })
      .then(() => {
        if (!this.searchAbort.signal.aborted && this.search.hasPendingWrites())
          this.searchMaintenance.wake();
      })
      .catch(this.onError);
    void this.longThreads.backfill(this, this.searchAbort.signal).catch(this.onError);
  }
  private onError: (error: unknown) => void;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const finished = Promise.withResolvers<void>();
    this.closing = finished.promise;
    void closeStore({
      flush: () => this.streaming.drain(),
      stop: [
        () => this.streaming.buffer.stop(),
        () => this.wal.close(),
        () => this.searchAbort.abort(),
        () => this.searchMaintenance.close(),
      ],
      workers: () => this.searchQueries.close(),
      release: () => {
        this.statements.clear();
        this.listeners.clear();
        this.usageListeners.clear();
        this.threadReads.clearViews();
        this.db.close();
      },
    }).then(finished.resolve, finished.reject);
    return this.closing;
  }
  /** Shared per-connection prepared statements; SQL text, never entity IDs, keys the bounded LRU. */
  statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement, 1);
    }
    return statement;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Wake analytics on committed events and durable deletion tombstones. */
  subscribeUsage(listener: () => void): () => void {
    if (this.usageListeners.size >= 16 && !this.usageListeners.has(listener))
      throw new Error("Usage subscription capacity reached");
    this.usageListeners.add(listener);
    return () => {
      this.usageListeners.delete(listener);
    };
  }
  headSeq(): number {
    return this.streaming.head();
  }
  liveWriteBlocked(): boolean {
    return this.streaming.buffer.failed;
  }
  hasLiveWrite(id: ThreadId): boolean {
    return this.streaming.buffer.has(id);
  }
  prepareLiveWrite(bytes: number): void {
    this.streaming.prepare(bytes);
  }
  bufferLiveWrite(
    id: ThreadId,
    payloads: EventPayload[],
    at: number,
    snapshot: BufferedSnapshot,
  ): void {
    this.streaming.append(id, payloads, at, snapshot);
  }
  flushLiveWrites(): void {
    this.streaming.flush();
  }
  streamingMetrics() {
    return {
      ...this.streaming.metrics(),
      transactions: this.transactions,
      eventRows: this.eventRows,
      walBytes: this.wal.bytes(),
      reads: { ...this.readCache.metrics },
    };
  }
  /** In-memory projections must reload after any rollback, including event-free saves. */
  rollbackGeneration(): number {
    return this.rolledBack;
  }
  /**
   * `outcome` marks rows that publish themselves (the live buffer's). Nested in an open
   * transaction, they settle only when the outermost one does: its commit runs `committed`
   * in sequence with the transaction's own events, and any rollback runs `rolledBack`.
   */
  private transaction<T>(run: () => T, outcome?: TransactionOutcome): T {
    if (!this.streaming.flushing) this.flushLiveWrites();
    if (this.installingHistory) {
      // installHistory drains the buffer before it begins; a live write retries after it.
      if (outcome) throw new Error("Store is busy");
      return run();
    }
    if (this.transactionEvents) {
      const length = this.transactionEvents.length;
      const settling = this.settlements.length;
      const savepoint = `nested_${++this.depth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = run();
        this.db.exec(`RELEASE ${savepoint}`);
        if (outcome) {
          this.transactionEvents.splice(length);
          this.settlements.push({ at: length, outcome });
        }
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        this.readCache.invalidate();
        this.rolledBack++;
        this.sidebarReads.invalidate();
        this.transactionEvents.length = length;
        this.settle(this.settlements.splice(settling), "rolledBack");
        throw error;
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionEvents = [];
    let result: T;
    let events: Event[];
    try {
      result = run();
      if (result instanceof Promise) throw new Error("Store transactions must be synchronous");
      events = this.transactionEvents;
      this.db.exec("COMMIT");
      this.transactions++;
      this.readCache.invalidate();
      this.wal.wake();
      this.eventRows += events.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.rolledBack++;
      this.sidebarReads.invalidate();
      this.settle(this.settlements.splice(0), "rolledBack");
      throw error;
    } finally {
      this.transactionEvents = undefined;
    }
    // The live buffer publishes its own commits: stored rows may compact a prefix that
    // subscribers have already received.
    const settlements = this.settlements.splice(0);
    if (outcome) outcome.committed();
    let from = 0;
    for (const settlement of settlements) {
      if (!outcome) this.publishFresh(events.slice(from, settlement.at));
      from = settlement.at;
      this.settle([settlement], "committed");
    }
    if (!outcome) this.publishFresh(events.slice(from));
    for (const listener of this.usageListeners) {
      try {
        listener();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          /* committed */
        }
      }
    }
    return result;
  }
  private settle(
    settlements: { outcome: TransactionOutcome }[],
    result: keyof TransactionOutcome,
  ): void {
    for (const { outcome } of settlements) {
      try {
        outcome[result]();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          /* The transaction has already settled. */
        }
      }
    }
  }
  private publishFresh(events: Event[]): void {
    this.publish(events.filter((event) => event.seq > this.publishedSeq));
  }
  /** A thread's live batch could not be stored: drop its views and stop its session. */
  private quarantine(thread: ThreadId, error: Error): void {
    this.threadReads.invalidateViews();
    try {
      this.onError(error);
    } catch {
      /* Quarantine has already released the store. */
    }
    for (const listener of this.quarantineListeners) {
      try {
        listener(thread, error);
      } catch {
        /* Each listener stops only its own work. */
      }
    }
  }
  /** Hear about threads whose live output was dropped after it could not be stored. */
  onLiveWriteQuarantine(listener: (thread: ThreadId, error: Error) => void): () => void {
    this.quarantineListeners.add(listener);
    return () => {
      this.quarantineListeners.delete(listener);
    };
  }
  /** Extend a receipt or event transaction on the same connection. No async I/O. */
  atomic<T>(run: (db: DatabaseSync) => T): T {
    return this.transaction(() => run(this.db));
  }
  /** Cap provider facts using the same blob owner and transaction as canonical events. */
  capRaw(raw: RawPayload[], threadId: ThreadId): RawPayload[] {
    return this.transaction(() => this.payloads.capRaw(raw, threadId));
  }
  private publish(events: Event[]): void {
    if (!events.length) return;
    if (this.historyWriting && !this.notifyingHistory) {
      const after = (events[0]?.seq ?? this.headSeq() + 1) - 1;
      this.deferredAfter = Math.min(this.deferredAfter ?? after, after);
      return;
    }
    this.publications.push(events);
    this.notifyingHistory = false;
    if (this.publishing) return;
    this.publishing = true;
    try {
      let batch: Event[] | undefined;
      while ((batch = this.publications.shift())) {
        this.publishedSeq = Math.max(this.publishedSeq, batch.at(-1)?.seq ?? this.publishedSeq);
        this.threadReads.updateViews(batch);
        const listeners = [...this.listeners];
        for (const listener of listeners) {
          try {
            listener(batch);
          } catch (error) {
            try {
              this.onError(error);
            } catch {
              /* Reporting must not disrupt committed delivery. */
            }
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }
  private historyWaiters = new Set<() => void>();
  isHistoryWriting(): boolean {
    return this.historyWriting;
  }
  /** Wait until neither history publication nor maintenance holds writes. */
  async writable(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (;;) {
      if (this.writes.isHeld()) {
        await this.writes.open(signal);
        continue;
      }
      if (!this.historyWriting) {
        if (!this.streaming.buffer.failed) return;
        // A failed live batch retries on its own backoff; it settles by committing or by
        // quarantining the threads whose rows cannot be stored.
        await this.streaming.buffer.settled(signal);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.historyWaiters.delete(ready);
          reject(signal?.reason);
        };
        this.historyWaiters.add(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
      signal?.throwIfAborted();
    }
  }
  /**
   * The write boundary: every mutation path awaits admission here. The commit itself stays
   * synchronous, so ownership checks inside `run` see the same state they commit against.
   */
  async write<T>(run: (db: DatabaseSync) => T, signal?: AbortSignal): Promise<T> {
    for (;;) {
      await this.writable(signal);
      // Recheck in the same turn as the commit; maintenance may have started meanwhile.
      if (!this.writes.isHeld() && !this.historyWriting) return this.atomic(run);
    }
  }
  /** Register a writer whose commits span awaits. Maintenance drains it before starting. */
  writer(): () => void {
    return this.writes.enter();
  }
  /**
   * Hold new writers with a bounded wait, drain in-flight ones, then run work exclusively.
   * Work receives the connection; it must leave no transaction open across its awaits.
   */
  maintenance<T>(work: (db: DatabaseSync) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.flushLiveWrites();
    return this.writes.exclusive(async () => {
      if (this.closing) throw new Error("Store is closed");
      if (this.transactionEvents || this.installingHistory) throw new Error("Store is busy");
      return work(this.db);
    }, signal);
  }
  /** Begin history publication once maintenance releases writers; queues rather than fails. */
  async startHistoryWriting(signal?: AbortSignal): Promise<void> {
    for (;;) {
      await this.writes.open(signal);
      // Same turn as the registration, so maintenance cannot start in between.
      if (!this.writes.isHeld()) return this.setHistoryWriting(true);
    }
  }
  setHistoryWriting(active: boolean): void {
    if (active && this.historyWriting) throw new Error("History publication in progress");
    // Metadata writers wait for the worker lock rather than failing at the first contention.
    this.db.exec("PRAGMA busy_timeout=5000");
    if (active) {
      // The publication worker writes on its own connection, so maintenance must drain it.
      this.historyWriter = this.writes.enter();
      this.historyWriting = true;
      this.deferredAfter = this.publishedSeq;
      return;
    }
    const after = this.deferredAfter;
    try {
      if (after !== undefined) {
        let cursor = Math.max(after, this.publishedSeq);
        // Keep the fence through all pages, including listener-created tail events.
        while (cursor < this.headSeq()) {
          const through = this.headSeq();
          const events = this.readEvents({ afterSeq: cursor, limit: 64 });
          if (!events.length) {
            this.coverDeletedTail(through);
            cursor = through;
            continue;
          }
          this.notifyingHistory = true;
          try {
            this.publish(events);
          } finally {
            this.notifyingHistory = false;
          }
          cursor = events.at(-1)?.seq ?? this.headSeq();
        }
      }
    } finally {
      this.historyWriting = false;
      this.historyWriter?.();
      this.historyWriter = undefined;
      this.deferredAfter = undefined;
      if (this.search.hasPendingWrites()) this.searchMaintenance.wake();
      for (const resolve of this.historyWaiters) resolve();
      this.historyWaiters.clear();
    }
  }
  installHistory(archive: ArchiveReader, at: number, cancelled: () => boolean): void {
    if (this.transactionEvents || this.installingHistory) throw new Error("Store is busy");
    this.flushLiveWrites();
    this.db.exec("BEGIN IMMEDIATE");
    this.installingHistory = true;
    try {
      installArchive(
        this.db,
        archive,
        (payload) => {
          this.appendEvents(archive.thread.id, [payload], at);
        },
        cancelled,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.rolledBack++;
      this.sidebarReads.invalidate();
      throw error;
    } finally {
      this.installingHistory = false;
    }
  }
  private coverDeletedTail(through: number): void {
    // Physical deletion removes event rows and reserves a tombstone sequence. A later
    // deletion can also remove the event at a notification's previously captured head.
    if (!this.statement("SELECT 1 FROM usage_deletions WHERE seq>=? LIMIT 1").get(through))
      throw new Error("Missing committed history events");
    this.publishedSeq = Math.max(this.publishedSeq, through);
  }
  async notifyHistory(after = this.publishedSeq): Promise<void> {
    after = Math.max(after, this.publishedSeq);
    const through = this.headSeq();
    while (after < through) {
      const events = this.readEvents({ afterSeq: after, limit: 16 }).filter(
        (event) => event.seq <= through,
      );
      if (!events.length) {
        this.coverDeletedTail(through);
        after = through;
        continue;
      }
      this.notifyingHistory = true;
      try {
        this.publish(events);
      } finally {
        this.notifyingHistory = false;
      }
      after = events.at(-1)?.seq ?? through;
      await setImmediate();
    }
    if (this.deferredAfter !== undefined)
      this.deferredAfter = Math.max(this.deferredAfter, through);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  getWorkspace(
    id: WorkspaceId,
  ): { path: string; name: string; icon?: string | null; defaultIcon?: string | null } | undefined {
    const row = this.statement(
      "SELECT id,path,name,(SELECT icon FROM workspace_metadata WHERE workspace_id=workspaces.id) AS icon,(SELECT default_icon FROM workspace_metadata WHERE workspace_id=workspaces.id) AS defaultIcon FROM workspaces WHERE id=?",
    ).get(id);
    if (!row) return undefined;
    const project = decodeProjectRow(row);
    return {
      path: project.path,
      name: project.name,
      ...(project.icon === undefined ? {} : { icon: project.icon }),
      ...(project.defaultIcon === undefined ? {} : { defaultIcon: project.defaultIcon }),
    };
  }
  executionWorkspace(id: ThreadId) {
    const thread = this.getThread(id);
    if (!thread) throw new Error("thread_not_found");
    if (!this.engineSessionsKnown)
      this.engineSessionsKnown = Boolean(
        this.statement(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'",
        ).get(),
      );
    const session = this.engineSessionsKnown
      ? this.statement("SELECT * FROM engine_sessions WHERE thread_id=?").get(id)
      : undefined;
    const binding = executionWorkspace(
      thread,
      session,
      session === undefined ? this.getWorkspacePath(thread.workspaceId) : undefined,
    );
    const root =
      session === undefined
        ? this.workspaceReservations.workspaceRoot(thread.workspaceId, binding.path)
        : binding.path;
    this.workspaceReservations.assertAvailable(root);
    return binding;
  }
  completeWorkspacePreparation(id: ThreadId, expectedPath: string, path: string): boolean {
    const thread = this.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return false;
    this.workspaceReservations.assertAvailable(expectedPath);
    this.workspaceReservations.assertAvailable(path);
    const result = this.statement(
      "UPDATE engine_sessions SET cwd=?,workspace_ready=1 WHERE thread_id=? AND cwd=? AND workspace_ready=0",
    ).run(path, id, expectedPath);
    return result.changes === 1;
  }
  importedSource(sourceId: string): Thread | undefined {
    const row = this.statement(
      "SELECT * FROM threads WHERE json_extract(imported,'$.sourceId')=?",
    ).get(sourceId);
    return row ? decodeThreadRow(row) : undefined;
  }
  createWorkspace(path: string, name: string, at = this.now()): WorkspaceId {
    return this.atomic(() => {
      const existing = this.statement("SELECT id FROM workspaces WHERE path = ?").get(path);
      const id = WorkspaceId.parse(existing?.id ?? this.nextId());
      if (!existing)
        this.statement("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(id, path, name, at);
      this.workspaceReservations.registerWorkspace(id, path);
      return id;
    });
  }
  getWorkspacePath(id: WorkspaceId): string | undefined {
    const row = this.statement("SELECT path FROM workspaces WHERE id = ?").get(id);
    return typeof row?.path === "string" ? row.path : undefined;
  }
  /**
   * Indexed fan-out to the current threads running in `root`: those whose session runs there,
   * and those not yet started whose project is that root. Threads in the project's other
   * checkouts never hear about it. Never scans event or transcript history.
   */
  recordWorkspaceFileChange(
    workspaceId: WorkspaceId,
    root: string,
    input: WorkspaceFileChange,
  ): void {
    const change = WorkspaceFileChange.parse(input);
    const sessions = Boolean(
      this.statement(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'",
      ).get(),
    );
    const projectRoot = this.workspaceReservations.workspaceRoot(workspaceId, "");
    const scope = sessions
      ? `(t.id IN (SELECT thread_id FROM engine_sessions WHERE cwd=?) OR (? AND NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.thread_id=t.id)))`
      : `(? IS NOT NULL AND ?)`;
    let after = "";
    for (;;) {
      const rows = this.statement(
        `SELECT t.id FROM threads t WHERE t.workspace_id=? AND t.archived_at IS NULL AND json_extract(t.client,'$.deletedAt') IS NULL AND ${scope} AND t.id>? ORDER BY t.id LIMIT 64`,
      ).all(workspaceId, root, projectRoot === root ? 1 : 0, after);
      if (!rows.length) return;
      this.transaction(() => {
        for (const row of rows) {
          const id = ThreadId.parse(row.id);
          this.appendEvents(id, [{ type: "workspace.files_changed", workspaceId, change }]);
          after = id;
        }
      });
    }
  }
  getThread(id: ThreadId): Thread | undefined {
    const row = this.statement("SELECT * FROM threads WHERE id = ?").get(id);
    if (!row) return undefined;
    return decodeThreadRow(row);
  }
  /** Live authorization checks do not need to deserialize a thread's historical payload. */
  hasLiveThread(id: ThreadId): boolean {
    return (
      this.statement(
        "SELECT 1 FROM threads WHERE id=? AND json_extract(client,'$.deletedAt') IS NULL",
      ).get(id) !== undefined
    );
  }
  updateBlockers(): number {
    return Number(
      this.statement(
        "SELECT COUNT(*) AS n FROM threads WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed')",
      ).get()?.n,
    );
  }
  sidebarPage(
    options: Parameters<SidebarReads["sidebarPage"]>[0],
    before?: Parameters<SidebarReads["sidebarPage"]>[1],
    reuse?: Parameters<SidebarReads["sidebarPage"]>[2],
  ) {
    return this.sidebarReads.sidebarPage(options, before, reuse);
  }
  /** Store owns all SQLite savepoints; SidebarReads owns only its page caches. */
  private sidebarSnapshot<T>(read: () => T): T {
    const name = `sidebar_read_${++this.sidebarSnapshotSeq}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      return read();
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      throw error;
    } finally {
      this.db.exec(`RELEASE ${name}`);
    }
  }
  listThreads(): Thread[] {
    return this.statement("SELECT * FROM threads ORDER BY updated_at DESC, id")
      .all()
      .map((row) => decodeThreadRow(row));
  }
  appendEvents(threadId: ThreadId, payloads: EventPayload[], at = this.now()): Event[] {
    return this.appendEventBatch(threadId, payloads, at);
  }
  private appendEventBatch(
    threadId: ThreadId,
    payloads: EventPayload[],
    at: number,
    envelopes?: Event[],
  ): Event[] {
    return this.transaction(() => {
      const events = this.eventWriter.append(threadId, payloads, at, envelopes);
      this.transactionEvents?.push(...events);
      return events;
    });
  }
  enqueueMcpIntent(id: string, intent: McpIntent, events: EventPayload[], at: number): void {
    const parsed = McpIntent.parse(intent);
    this.transaction(() => {
      if (!this.mcp.getAgent(parsed.threadId, parsed.agentId))
        throw new Error("Unknown MCP caller");
      this.mcp.enqueue(id, parsed);
      this.appendEvents(parsed.threadId, events, at);
    });
  }
  readMcpIntents(limit = 100, type?: "mcp.notify") {
    return this.mcp.read(limit, type);
  }
  acknowledgeMcpIntent(id: string): boolean {
    return this.transaction(() => this.mcp.acknowledge(id));
  }
  /** `provider:nativeId` of every provider session an ace thread already holds, imported or not. */
  nativeSessionKeys(): string[] {
    return this.statement(
      `SELECT json_extract(payload,'$.native.provider')||':'||json_extract(payload,'$.native.nativeId') AS key FROM mcp_agents WHERE json_extract(payload,'$.native.nativeId') IS NOT NULL
      UNION SELECT json_extract(imported,'$.native.provider')||':'||json_extract(imported,'$.native.nativeId') FROM threads WHERE json_extract(imported,'$.native.nativeId') IS NOT NULL`,
    )
      .all()
      .map((row) => String(row.key));
  }
  getMcpAgent(threadId: ThreadId, agentId: string) {
    return this.mcp.getAgent(threadId, agentId);
  }
  listMcpAgents(threadId: ThreadId, cursor: string, limit: number) {
    return this.mcp.agents(threadId, cursor, limit);
  }
  /** A cursor inside a compacted delta span needs a fresh snapshot to avoid double append. */
  replaySafe(afterSeq: number): boolean {
    return this.streaming.replaySafe(afterSeq);
  }
  readEvents(options: {
    afterSeq: number;
    threadId?: ThreadId;
    limit: number;
    byteLimit?: number;
  }): Event[] {
    this.flushLiveWrites();
    const rows =
      options.threadId === undefined
        ? this.statement("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").iterate(
            options.afterSeq,
            options.limit,
          )
        : this.statement(
            "SELECT * FROM events WHERE seq > ? AND thread_id = ? ORDER BY seq LIMIT ?",
          ).iterate(options.afterSeq, options.threadId, options.limit);
    const events: Event[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = Event.parse({
        seq: row.seq,
        id: row.id,
        threadId: row.thread_id,
        at: row.at,
        payload: JSON.parse(String(row.payload)),
      });
      events.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event));
      // Include the crossing event so replay's caller can distinguish overflow from completion.
      if (bytes > (options.byteLimit ?? Infinity)) break;
    }
    return events;
  }
  readSearchPage(options: { afterSeq: number; limit: number; maxBytes: number }) {
    this.flushLiveWrites();
    return this.searchReplay.read(options, this.headSeq());
  }
  /** Usage replay skips transcript/output payloads while advancing host coverage. */
  readUsagePage(options: { afterSeq: number; limit: number; maxBytes?: number }) {
    this.flushLiveWrites();
    return this.usageReplay.read(options, this.headSeq());
  }
  recordCommand(commandId: CommandId, deviceId: DeviceId, run: () => CommandResult): CommandResult {
    return this.receipts.recordCommand(commandId, deviceId, run);
  }
  commandReceipt(commandId: CommandId, deviceId: DeviceId): CommandResult | undefined {
    return this.receipts.commandReceipt(commandId, deviceId);
  }
  completeAsyncCommand(id: CommandId, input: CommandResult): CommandResult {
    return this.receipts.completeAsyncCommand(id, input);
  }
  releaseReviewCommand(commandId: CommandId, deviceId: DeviceId): void {
    this.receipts.releaseReviewCommand(commandId, deviceId);
  }
  completeReviewCommand(
    commandId: CommandId,
    deviceId: DeviceId,
    input: CommandResult,
  ): CommandResult {
    return this.receipts.completeReviewCommand(commandId, deviceId, input);
  }
  acquireThread(id: ThreadId): ThreadView {
    return this.threadReads.acquireThread(id);
  }
  snapshotThread(id: ThreadId): ThreadView {
    return this.threadReads.snapshotThread(id);
  }
  readEntityPage(
    threadId: ThreadId,
    collection: import("@ace/protocol").EntityCollection,
    before: number,
    limit: number,
  ) {
    return this.threadReads.readEntityPage(threadId, collection, before, limit);
  }
  getInteraction(id: string) {
    return this.threadReads.getInteraction(id);
  }
  /** The event seq that created an item, or undefined while the thread has no such item. */
  itemCreatedSeq(threadId: ThreadId, itemId: string): number | undefined {
    this.flushLiveWrites();
    return this.payloads.itemCreatedSeq(threadId, itemId);
  }
  readItems(threadId: ThreadId, before: number, limit: number) {
    return this.threadReads.readItems(threadId, before, limit);
  }
  turnsPage(input: Omit<TurnsQuery, "type" | "requestId"> & { requestId?: string }) {
    return this.navigation.turnsPage(input);
  }
  turnSteps(
    input: Omit<StepsQuery, "type" | "requestId" | "limit"> & {
      requestId?: string;
      limit?: number;
    },
    cachedIcon?: TurnStepsSource["cachedIcon"],
  ) {
    return this.navigation.turnSteps(input, cachedIcon);
  }
  /** A recorded step's site or app, worked out by the daemon (`icons.resolve`). */
  stepSurface(threadId: ThreadId, itemId: string) {
    return this.navigation.stepSurface(threadId, itemId);
  }
  itemsWindow(input: Omit<WindowQuery, "type" | "requestId"> & { requestId?: string }) {
    return this.navigation.itemsWindow(input);
  }
  threadSearch(
    input: Omit<ThreadSearchQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    return this.navigation.threadSearch(input, authorize);
  }
  threadCatchUp(
    input: Omit<CatchUpQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    return this.navigation.threadCatchUp(input, authorize);
  }
  threadReadState(threadId: ThreadId, deviceId: DeviceId, requestId = "read-state") {
    return this.navigation.threadReadState(threadId, deviceId, requestId);
  }
  markThreadRead(threadId: ThreadId, deviceId: DeviceId, lastSeenSeq: number): void {
    return this.navigation.markThreadRead(threadId, deviceId, lastSeenSeq);
  }
  outputThread(streamId: string) {
    return this.threadReads.outputThread(streamId);
  }
  readItemPage(threadId: ThreadId, before: number, limit: number, byteLimit = 1024 * 1024) {
    return this.threadReads.readItemPage(threadId, before, limit, byteLimit);
  }
  /** A page that shows an item too large for it without raw payloads, or summarized. */
  readBoundedItemPage(threadId: ThreadId, before: number, limit: number, byteLimit: number) {
    return this.threadReads.readBoundedItemPage(threadId, before, limit, byteLimit);
  }
  appendRawChunk(threadId: ThreadId, chunk: unknown): void {
    this.payloads.streamed.append(threadId, chunk);
  }
  readRawChunk(blobRef: string, offset: number, limit: number): Uint8Array {
    return this.threadReads.readRawChunk(blobRef, offset, limit);
  }
  historicalItemCount(threadId: ThreadId, through: number): number {
    return this.threadReads.historicalItemCount(threadId, through);
  }
  historicalItemCompletion(threadId: ThreadId, itemId: ItemId) {
    return this.threadReads.historicalItemCompletion(threadId, itemId);
  }
  historicalOpening(threadId: ThreadId, through: number) {
    return this.threadReads.historicalOpening(threadId, through);
  }
  readHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit = 1024 * 1024,
  ) {
    return this.threadReads.readHistoricalItemPage(threadId, through, before, limit, byteLimit);
  }
  readBoundedHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit: number,
  ) {
    return this.threadReads.readBoundedHistoricalItemPage(
      threadId,
      through,
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
    return this.threadReads.readHistoricalStream(threadId, streamId, through, offset, limit);
  }
  blobInfo(blobRef: string) {
    return this.threadReads.blobInfo(blobRef);
  }
  outputInfo(streamId: string) {
    return this.threadReads.outputInfo(streamId);
  }
  readOutputBytes(streamId: string, offset: number, limit: number) {
    return this.threadReads.readOutputBytes(streamId, offset, limit);
  }
  readOutput(streamId: string, offset: number, limit: number) {
    return this.threadReads.readOutput(streamId, offset, limit);
  }
  readHistoryBlob(threadId: ThreadId, id: string, offset: number, limit: number) {
    return this.threadReads.readHistoryBlob(threadId, id, offset, limit);
  }
  private recordDataDeletion(id: ThreadId): void {
    const previousSeq = this.headSeq();
    const seq = this.sequences.next(previousSeq);
    if (!Number.isSafeInteger(seq)) throw new Error("Sequence exhausted");
    this.statement("INSERT INTO usage_deletions VALUES (?, ?, ?)").run(seq, id, this.now());
    this.statement("UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1").run(seq);
    this.search.deleteThread(id);
    this.search.acknowledgeDeletion(seq, previousSeq);
    if (this.longThreads.data.indexedSeq() === previousSeq)
      this.longThreads.data.run("UPDATE long_meta SET seq=? WHERE id=1", seq);
    this.mcp.deleteThread(id);
  }
  /** Remove payloads after a durable tombstone; preserve replay/foreign-key identities. */
  purgeThreadData(id: ThreadId): void {
    this.transaction(() => {
      this.recordDataDeletion(id);
      purgeTranscript(this.db, id);
    });
    this.threadReads.forget(id);
  }
  deleteThread(id: ThreadId): void {
    this.transaction(() => {
      if (!this.getThread(id)) return;
      this.recordDataDeletion(id);
      this.statement("DELETE FROM events WHERE thread_id = ?").run(id);
      this.statement("DELETE FROM threads WHERE id = ?").run(id);
    });
    this.threadReads.forget(id);
  }
  releaseThread(id: ThreadId): void {
    return this.threadReads.releaseThread(id);
  }
  /** Threads a client is viewing now (an open thread subscription holds them). */
  viewedThreads(): ThreadId[] {
    return this.threadReads.heldThreads();
  }
}
