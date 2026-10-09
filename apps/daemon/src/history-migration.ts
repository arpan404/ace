import type { DatabaseSync } from "node:sqlite";
import { AgentId, ThreadId, type EventPayload, type Thread } from "@ace/protocol";

/** Old imports had no live execution, but were saved as new/unresponsive threads. */
export function settleLegacyImports(
  db: DatabaseSync,
  read: (id: ThreadId) => Thread | undefined,
  append: (id: ThreadId, payloads: EventPayload[], at: number) => void,
): void {
  const key = "settle-history-imports-v1";
  if (db.prepare("SELECT id FROM upgrade_cleanup WHERE id=?").get(key)) return;
  const candidates = db.prepare(`SELECT id FROM threads t WHERE imported IS NOT NULL
    AND json_extract(status,'$.state') IN ('new','unresponsive','done')
    AND NOT EXISTS (SELECT 1 FROM view_entities v WHERE v.thread_id=t.id AND (
      v.collection='runs' OR
      (v.collection='agents' AND json_extract(v.value,'$.status.state') NOT IN ('idle','unresponsive','interrupted')) OR
      (v.collection='backgroundTasks' AND json_extract(v.value,'$.status')='running') OR
      (v.collection='interactions' AND json_extract(v.value,'$.state')='pending') OR
      (v.collection='queue' AND json_array_length(v.value,'$.messages')>0)))
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.thread_id=t.id AND e.type='thread.client.updated'
      AND json_type(e.payload,'$.changes.settledAt') IS NOT NULL)`);
  const adopted = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'")
    .get()
    ? db.prepare("SELECT 1 FROM engine_sessions WHERE thread_id=?")
    : undefined;
  const agents = db.prepare(
    "SELECT id FROM view_entities WHERE thread_id=? AND collection='agents' AND json_extract(value,'$.status.state')='unresponsive'",
  );
  for (const row of candidates.iterate()) {
    const id = ThreadId.parse(row.id),
      thread = read(id);
    if (
      !thread?.imported ||
      thread.settledAt !== undefined ||
      thread.deletedAt !== undefined ||
      adopted?.get(id)
    )
      continue;
    const at = thread.imported.importedAt;
    for (const agent of agents.iterate(id))
      append(
        id,
        [{ type: "agent.status", agentId: AgentId.parse(agent.id), status: { state: "idle" } }],
        at,
      );
    append(
      id,
      [
        { type: "thread.updated", status: { state: "done" } },
        {
          type: "thread.client.updated",
          changes: {
            settledAt: at,
            settledReason: "manual",
            unread: false,
            readAt: at,
            autoSettleAt: null,
          },
        },
      ],
      at,
    );
  }
  db.prepare("INSERT INTO upgrade_cleanup VALUES (?)").run(key);
}
