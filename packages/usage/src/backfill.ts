import { compactEvent, type UsageBatch } from "./events.ts";
import type { Event } from "@ace/protocol";
export interface UsageSink {
  cursor(): Promise<number>;
  ingest(batch: UsageBatch): Promise<number>;
}
export interface EventHistory {
  readUsagePage(options: { afterSeq: number; limit: number }): {
    throughSeq: number;
    events: Event[];
  };
}
/** One bounded batch. The scheduler yields between calls and resumes from SQLite. */
export async function backfillBatch(sink: UsageSink, history: EventHistory): Promise<boolean> {
  const afterSeq = await sink.cursor();
  const page = history.readUsagePage({ afterSeq, limit: 256 });
  if (page.throughSeq <= afterSeq) return false;
  let start = afterSeq;
  let compact: UsageBatch["events"] = [];
  for (const event of page.events) {
    const usage = compactEvent(event);
    if (usage) compact.push(usage);
    if (compact.length === 16) {
      await sink.ingest({ afterSeq: start, throughSeq: event.seq, events: compact });
      start = event.seq;
      compact = [];
    }
  }
  if (page.throughSeq > start)
    await sink.ingest({ afterSeq: start, throughSeq: page.throughSeq, events: compact });
  return true;
}
