import { z } from "zod";
import { ThreadId, type Event } from "@ace/protocol";
import { itemDigestContribution } from "@ace/projection";
import { LongThreadDatabase } from "./database.ts";
import { Ranges } from "./ranges.ts";
import { RangeFileMigration } from "./range-file-migration.ts";

const State = z.object({
  stage: z.number(),
  through: z.number(),
  thread: z.string(),
  key: z.string(),
  seq: z.number(),
});
const CounterRow = z.object({
  thread_id: z.string(),
  key: z.string(),
  seq: z.number(),
  at: z.number(),
  value: z.number(),
});
const FileRow = z.object({
  thread_id: ThreadId,
  path: z.string(),
  seq: z.number(),
  at: z.number(),
  added: z.number(),
  removed: z.number(),
  unknown: z.number(),
});
const TurnRow = z.object({
  thread_id: z.string(),
  ordinal: z.number(),
  settled_seq: z.number().nullable(),
  ended_at: z.number().nullable(),
});

/** Upgrade the previous index in durable 128-row transactions, without changing event time. */
export class RangeMigration {
  private readonly ranges: Ranges;
  private readonly files: RangeFileMigration;
  constructor(privateData: LongThreadDatabase, repair: (thread: string, ordinal: number) => void) {
    this.data = privateData;
    this.ranges = new Ranges(privateData);
    this.files = new RangeFileMigration(privateData, this.ranges);
    this.repair = repair;
  }
  private readonly data: LongThreadDatabase;
  private readonly repair: (thread: string, ordinal: number) => void;
  done(): boolean {
    return this.state().stage === 6;
  }
  private state() {
    return State.parse(
      this.data
        .sql("SELECT stage,through,thread,key,seq FROM long_range_migration WHERE id=1")
        .get(),
    );
  }
  private cursor(thread: string, key: string, seq: number): void {
    this.data.run(
      "UPDATE long_range_migration SET thread=?,key=?,seq=? WHERE id=1",
      thread,
      key,
      seq,
    );
  }
  private next(): void {
    this.data.run(
      "UPDATE long_range_migration SET stage=stage+1,thread='',key='',seq=0 WHERE id=1",
    );
  }
  batch(readEvents: (after: number, limit: number) => Event[]): void {
    const state = this.state();
    if (state.stage === 0) {
      const rows = this.data
        .sql(
          "SELECT thread_id,key,seq,at,value FROM long_prefix WHERE (thread_id,key,seq)>(?,?,?) AND seq<=? ORDER BY thread_id,key,seq LIMIT 128",
        )
        .all(state.thread, state.key, state.seq, state.through)
        .map((row) => CounterRow.parse(row));
      for (const row of rows) {
        const previous = this.data
          .sql(
            "SELECT value FROM long_prefix WHERE thread_id=? AND key=? AND seq<? ORDER BY seq DESC LIMIT 1",
          )
          .get(row.thread_id, row.key, row.seq);
        this.ranges.add(
          row.thread_id,
          "counters",
          row.key,
          row.at,
          row.value - Number(previous?.value ?? 0),
        );
        this.cursor(row.thread_id, row.key, row.seq);
      }
      if (rows.length < 128) this.next();
    } else if (state.stage === 1) {
      const rows = this.data
        .sql(
          "SELECT p.thread_id,p.path,p.seq,e.at,p.added,p.removed,p.unknown FROM long_file_prefix p JOIN events e ON e.seq=p.seq WHERE (p.thread_id,p.path,p.seq)>(?,?,?) AND p.seq<=? ORDER BY p.thread_id,p.path,p.seq LIMIT 128",
        )
        .all(state.thread, state.key, state.seq, state.through)
        .map((row) => FileRow.parse(row));
      for (const row of rows) {
        const previous = this.data
          .sql(
            "SELECT added,removed,unknown FROM long_file_prefix WHERE thread_id=? AND path=? AND seq<? ORDER BY seq DESC LIMIT 1",
          )
          .get(row.thread_id, row.path, row.seq);
        this.ranges.file(
          { threadId: row.thread_id, seq: row.seq, at: row.at },
          row.path,
          row.added - Number(previous?.added ?? 0),
          row.removed - Number(previous?.removed ?? 0),
          row.unknown - Number(previous?.unknown ?? 0),
          0,
        );
        this.cursor(row.thread_id, row.path, row.seq);
      }
      if (rows.length < 128) this.next();
    } else if (state.stage === 2) {
      const events = readEvents(state.seq, 128).filter((event) => event.seq <= state.through);
      for (const event of events) {
        this.files.record(event);
        const p = event.payload;
        if (p.type === "item.created" || p.type === "item.updated") {
          const command = itemDigestContribution(p.item).commands[0];
          if (command || this.knownCommand(event.threadId, p.item.id))
            this.ranges.command(event, p.item.id, command);
        } else if (p.type === "item.deleted" && this.knownCommand(event.threadId, p.itemId))
          this.ranges.command(event, p.itemId, undefined);
        this.cursor("", "", event.seq);
      }
      if (events.length < 128 || events.at(-1)?.seq === state.through) this.next();
    } else if (state.stage === 3 || state.stage === 4) {
      const rows = this.data
        .sql(
          "SELECT thread_id,ordinal,settled_seq,ended_at FROM long_turns WHERE (thread_id,ordinal)>(?,?) ORDER BY thread_id,ordinal LIMIT 128",
        )
        .all(state.thread, state.seq)
        .map((row) => TurnRow.parse(row));
      for (const row of rows) {
        if (
          state.stage === 3 &&
          row.settled_seq !== null &&
          row.settled_seq <= state.through &&
          row.ended_at !== null
        )
          this.ranges.completion(row.thread_id, row.ordinal, {
            seq: row.settled_seq,
            at: row.ended_at,
          });
        if (state.stage === 4) this.repair(row.thread_id, row.ordinal);
        this.cursor(row.thread_id, "", row.ordinal);
      }
      if (rows.length < 128) this.next();
    } else if (state.stage === 5 && this.files.cleanup()) {
      this.next();
    }
  }
  private knownCommand(thread: string, item: string): boolean {
    return !!this.data
      .sql("SELECT 1 FROM long_time_commands WHERE thread_id=? AND item_id=?")
      .get(thread, item);
  }
}
