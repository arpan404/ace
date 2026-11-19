import { z } from "zod";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/**
 * Repair the event/subscriber crash gap before admitting work. Page indexed accounting events only.
 *
 * Once a thread's history holds no accounting event past its replay position, the position moves
 * to the thread's newest event, so the next start reads only what was written since this one.
 * Without that, every start re-reads each delegated thread's tail after its last usage sample,
 * row by row, on a cold page cache (tens of thousands of random reads on a large home).
 */
export function recoverLocalUsage(store: Store, journal: DelegationJournal) {
  const accounting = store.statement(`SELECT seq FROM events WHERE thread_id=? AND seq>?
          AND type IN ('run.started','usage.updated') ORDER BY seq LIMIT 128`);
  // Index-only: events_thread_seq answers this without reading a row.
  const newest = store.statement("SELECT MAX(seq) AS seq FROM events WHERE thread_id=?");
  let afterThread = "";
  for (;;) {
    const threads = journal.usageThreads(afterThread);
    if (!threads.length) return;
    for (const member of threads) {
      afterThread = member.thread_id;
      for (;;) {
        // One write transaction: the live buffer is flushed first and nothing commits in
        // between, so an empty page means no accounting event at or below `through` is unread.
        const page = store.atomic(() => {
          const after = journal.usageOffset(member.thread_id);
          const rows = accounting.all(member.thread_id, after);
          if (rows.length) return rows;
          const through = newest.get(member.thread_id)?.seq;
          if (typeof through === "number" && through > after)
            journal.advanceUsageOffset(member.thread_id, through);
          return rows;
        });
        if (!page.length) break;
        store.atomic(() => {
          for (const row of page) {
            const seq = z.number().int().positive().parse(row.seq);
            const event = store.readEvents({
              threadId: member.thread_id,
              afterSeq: seq - 1,
              limit: 1,
              byteLimit: 64 * 1024,
            })[0];
            if (!event || event.seq !== seq) throw new Error("Accounting event unavailable");
            journal.account(member.root_id, event);
          }
        });
      }
    }
  }
}
