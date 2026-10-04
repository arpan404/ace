import { setImmediate } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { Event, Thread, ThreadId } from "@ace/protocol";
import { LongThreadDatabase } from "./database.ts";
import { TurnWriter } from "./writer.ts";
import { TurnReader } from "./reader.ts";

interface Source {
  headSeq(): number;
  getThread(id: ThreadId): Thread | undefined;
  readEvents(input: { afterSeq: number; limit: number }): Event[];
  atomic<T>(run: (db: DatabaseSync) => T): T;
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
    while (!signal.aborted) {
      const through = source.headSeq();
      if (this.data.indexedSeq() >= through) return;
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
  }
}
