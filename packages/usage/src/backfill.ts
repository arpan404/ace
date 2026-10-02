import { compactEvent, UsageEvent, type UsageBatch } from "./events.ts";
import type { Event } from "@ace/protocol";
export interface UsageSink {
  cursor(): Promise<number>;
  ingest(batch: UsageBatch): Promise<number>;
}
export interface EventHistory {
  readUsagePage(options: { afterSeq: number; limit: number; maxBytes?: number }): {
    throughSeq: number;
    events: (Event | UsageEvent)[];
  };
}
/** One bounded batch. The scheduler yields between calls and resumes from SQLite. */
export async function backfillBatch(sink: UsageSink, history: EventHistory): Promise<boolean> {
  const afterSeq = await sink.cursor();
  const page = history.readUsagePage({ afterSeq, limit: 256 });
  if (page.throughSeq <= afterSeq) return false;
  let start = afterSeq;
  let compact: UsageBatch["events"] = [];
  let bytes = 0;
  for (const event of page.events) {
    const usage = "id" in event ? compactEvent(event) : UsageEvent.parse(event);
    const size = usage ? Buffer.byteLength(JSON.stringify(usage)) : 0;
    if (compact.length && bytes + size > 512 * 1024) {
      const throughSeq = compact.at(-1)?.seq ?? start;
      await sink.ingest({ afterSeq: start, throughSeq, events: compact });
      start = throughSeq;
      compact = [];
      bytes = 0;
    }
    if (usage) compact.push(usage);
    bytes += size;
    if (compact.length === 16) {
      await sink.ingest({ afterSeq: start, throughSeq: event.seq, events: compact });
      start = event.seq;
      compact = [];
      bytes = 0;
    }
  }
  if (page.throughSeq > start)
    await sink.ingest({ afterSeq: start, throughSeq: page.throughSeq, events: compact });
  return true;
}
