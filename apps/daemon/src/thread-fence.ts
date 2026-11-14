import type { StatementSync } from "node:sqlite";

/**
 * Whether work started on `threadId` after event `seq`: a run started (any agent's), or a
 * person's own message arrived. A command decided at `seq` that stops a thread's work (a forced
 * delete, an archive) is refused then (`thread_changed`): what it would stop is newer than what
 * the person saw, which a command replayed from a client's outbox after a reconnect can be.
 */
export function workStartedSince(
  store: { statement(sql: string): StatementSync },
  threadId: string,
  seq: number,
): boolean {
  return (
    store
      .statement(
        `SELECT 1 FROM events WHERE thread_id=? AND seq>? AND (type='run.started' OR
        (type='item.created' AND json_extract(payload,'$.item.role')='user' AND
         COALESCE(json_extract(payload,'$.item.synthetic'),0)=0)) LIMIT 1`,
      )
      .get(threadId, seq) !== undefined
  );
}
