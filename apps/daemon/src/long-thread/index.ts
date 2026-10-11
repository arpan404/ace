import { setImmediate, setTimeout } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { Event, EventPayload, Thread, ThreadId } from "@ace/protocol";
import { LongThreadDatabase } from "./database.ts";
import { TurnWriter } from "./writer.ts";
import { TurnReader } from "./reader.ts";
import { RangeMigration } from "./range-migration.ts";
import { CompletionMigration } from "./completion-migration.ts";
import { isStoreBusy } from "../store-busy.ts";

interface Source {
  headSeq(): number;
  getThread(id: ThreadId): Thread | undefined;
  readEvents(input: {
    afterSeq: number;
    limit: number;
    threadId?: ThreadId;
    byteLimit?: number;
  }): Event[];
  atomic<T>(run: (db: DatabaseSync) => T): T;
  appendEvents(id: ThreadId, events: EventPayload[], at: number): unknown;
  isHistoryWriting(): boolean;
  writable(signal: AbortSignal): Promise<void>;
}
export class LongThreadIndex {
  readonly data: LongThreadDatabase;
  readonly reader: TurnReader;
  private readonly writer: TurnWriter;
  constructor(db: DatabaseSync, getThread: (id: string) => Thread | undefined) {
    this.data = new LongThreadDatabase(db);
    this.writer = new TurnWriter(this.data);
    this.reader = new TurnReader(this.data, getThread);
  }
  append(event: Event, thread: Thread): void {
    if (this.data.indexedSeq() === event.seq - 1) this.writer.record(event, thread);
  }
  async backfill(source: Source, signal: AbortSignal): Promise<void> {
    let delay = 100;
    while (!signal.aborted) {
      try {
        await this.replay(source, signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (!isStoreBusy(error)) throw error;
        // Every batch commits its cursor atomically. Retry from that durable cursor.
        await setTimeout(delay, undefined, { signal }).catch((waitingError: unknown) => {
          if (!signal.aborted) throw waitingError;
        });
        delay = Math.min(delay * 2, 1000);
      }
    }
  }
  private async replay(source: Source, signal: AbortSignal): Promise<void> {
    const migration = new RangeMigration(this.data, (thread, ordinal) =>
      this.writer.repairPreviews(thread, ordinal),
    );
    while (!signal.aborted && !migration.done()) {
      if (source.isHistoryWriting()) await source.writable(signal);
      if (signal.aborted) return;
      source.atomic(() =>
        migration.batch((afterSeq, limit) => source.readEvents({ afterSeq, limit })),
      );
      // Empty databases complete synchronously, before their first live append.
      if (this.data.indexedSeq() > 0 && !migration.done()) await setImmediate();
    }
    while (!signal.aborted) {
      if (source.isHistoryWriting()) await source.writable(signal);
      if (signal.aborted) return;
      const through = source.headSeq();
      if (this.data.indexedSeq() >= through) break;
      source.atomic(() => {
        const events = source.readEvents({ afterSeq: this.data.indexedSeq(), limit: 128 });
        for (const event of events) {
          const thread = source.getThread(event.threadId);
          if (thread && thread.deletedAt === undefined) this.writer.record(event, thread);
          else this.data.run("UPDATE long_meta SET seq=? WHERE id=1", event.seq);
        }
        if (events.length < 128) this.data.run("UPDATE long_meta SET seq=? WHERE id=1", through);
      });
      await setImmediate();
    }
    const completion = new CompletionMigration(this.data);
    while (!signal.aborted && !completion.done()) {
      if (source.isHistoryWriting()) await source.writable(signal);
      if (signal.aborted) return;
      source.atomic(() => completion.batch(source));
      if (!completion.done()) await setImmediate();
    }
  }
}
