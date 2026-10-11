import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/** One-time upgrade replay, before incoming completions or new work can be admitted.
 * Only indexed run/usage events are read, in small pages, never transcript/output data.
 * Reusing the journal's counter owner also seeds deduplication for later cumulative frames.
 */
export function recoverIncomingUsage(store: Store, journal: DelegationJournal, now: number) {
  const incoming = store.atomic((db) => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS delegation_incoming_usage_recovery(root_id TEXT PRIMARY KEY)",
    );
    return !!db.prepare("SELECT name FROM sqlite_master WHERE name='remote_agent_incoming'").get();
  });
  if (!incoming) return;
  let afterRoot = "";
  for (;;) {
    const roots = store.atomic((db) =>
      db
        .prepare(`SELECT incoming.thread_id FROM remote_agent_incoming incoming
      JOIN threads ON threads.id=incoming.thread_id
      WHERE incoming.thread_id>? AND json_extract(threads.client,'$.deletedAt') IS NULL
      AND NOT EXISTS (SELECT 1 FROM delegation_incoming_usage_recovery recovery WHERE recovery.root_id=incoming.thread_id)
      ORDER BY incoming.thread_id LIMIT 64`)
        .all(afterRoot),
    );
    if (!roots.length) return;
    for (const row of roots) {
      const root = ThreadId.parse(row.thread_id);
      afterRoot = root;
      store.atomic((db) => {
        journal.tree(root, now);
        let after = 0;
        for (;;) {
          const page = db
            .prepare(`SELECT seq FROM events WHERE thread_id=? AND seq>?
          AND type IN ('run.started','usage.updated') ORDER BY seq LIMIT 128`)
            .all(root, after);
          if (!page.length) break;
          for (const entry of page) {
            const seq = z.number().int().positive().parse(entry.seq);
            for (const event of store.readEvents({
              threadId: root,
              afterSeq: seq - 1,
              limit: 1,
              byteLimit: 64 * 1024,
            })) {
              journal.started(event);
              journal.usage(root, event);
            }
            after = seq;
          }
        }
        // Persist the counters and marker atomically; an interrupted replay retries safely.
        db.prepare("INSERT INTO delegation_incoming_usage_recovery VALUES (?)").run(root);
      });
    }
  }
}
