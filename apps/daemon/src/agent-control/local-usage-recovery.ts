import { z } from "zod";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/** Repair the event/subscriber crash gap before admitting work. Page indexed accounting events only. */
export function recoverLocalUsage(store: Store, journal: DelegationJournal) {
  let afterThread = "";
  for (;;) {
    const threads = journal.usageThreads(afterThread);
    if (!threads.length) return;
    for (const member of threads) {
      afterThread = member.thread_id;
      for (;;) {
        const after = journal.usageOffset(member.thread_id);
        const page = store.atomic(db => db.prepare(`SELECT seq FROM events WHERE thread_id=? AND seq>?
          AND type IN ('run.started','usage.updated') ORDER BY seq LIMIT 128`).all(member.thread_id, after));
        if (!page.length) break;
        store.atomic(() => {
          for (const row of page) {
            const seq = z.number().int().positive().parse(row.seq);
            const event = store.readEvents({ threadId: member.thread_id, afterSeq: seq - 1, limit: 1, byteLimit: 64 * 1024 })[0];
            if (!event || event.seq !== seq) throw new Error("Accounting event unavailable");
            journal.account(member.root_id, event);
          }
        });
      }
    }
  }
}
