import { liveMetadata } from "@ace/projection";
import type { DatabaseSync } from "node:sqlite";
import {
  Agent,
  BackgroundTask,
  ThreadId,
  ThreadClientFields,
  type EventPayload,
  type Thread,
} from "@ace/protocol";

/** Indexed single-entity lookups, before the status owner replaces that entity. */
export function liveMetadataChange(
  db: DatabaseSync,
  thread: Thread,
  payload: EventPayload,
): EventPayload | undefined {
  let oldAgent: Agent | undefined;
  let oldTask: BackgroundTask | undefined;
  if (payload.type === "agent.created") {
    const row = db
      .prepare("SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?")
      .get(thread.id, payload.agent.id);
    if (row) oldAgent = Agent.parse(JSON.parse(String(row.value)));
  }
  if (payload.type === "background_task.started" || payload.type === "background_task.updated") {
    const id = payload.type === "background_task.started" ? payload.task.id : payload.taskId;
    const row = db
      .prepare(
        "SELECT value FROM view_entities WHERE thread_id=? AND collection='backgroundTasks' AND id=?",
      )
      .get(thread.id, id);
    if (row) oldTask = BackgroundTask.parse(JSON.parse(String(row.value)));
  }
  return liveMetadata(thread, payload, oldAgent, oldTask);
}
export function migrateThreadClient(db: DatabaseSync): void {
  if (
    !db
      .prepare("PRAGMA table_info(threads)")
      .all()
      .some((column) => column.name === "client")
  )
    db.exec("ALTER TABLE threads ADD COLUMN client JSON");
}
export function encodeThreadClient(thread: Thread): string {
  return JSON.stringify(ThreadClientFields.parse(thread));
}

/** One startup migration seeds counters from the existing materialization, never transcript history. */
export function seedThreadClient(
  db: DatabaseSync,
  read: (id: import("@ace/protocol").ThreadId) => Thread | undefined,
): void {
  db.exec("CREATE TABLE IF NOT EXISTS client_thread_migration(id INTEGER PRIMARY KEY)");
  if (db.prepare("SELECT id FROM client_thread_migration WHERE id=1").get()) return;
  const agents = db.prepare(
    "SELECT count(*) AS n FROM view_entities WHERE thread_id=? AND collection='agents' AND json_extract(value,'$.origin')!='root'",
  );
  const tasks = db.prepare(
    "SELECT count(*) AS n FROM view_entities WHERE thread_id=? AND collection='backgroundTasks' AND json_extract(value,'$.status')='running'",
  );
  const root = db.prepare(
    "SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?",
  );
  const write = db.prepare("UPDATE threads SET client=? WHERE id=?");
  for (const row of db.prepare("SELECT id FROM threads").iterate()) {
    const thread = read(ThreadId.parse(row.id));
    if (!thread) continue;
    const entity = thread.rootAgentId ? root.get(thread.id, thread.rootAgentId) : undefined;
    const model = entity ? Agent.parse(JSON.parse(String(entity.value))).model : undefined;
    write.run(
      encodeThreadClient({
        ...thread,
        live: {
          ...thread.live,
          provider: thread.provider,
          ...(model ? { model } : {}),
          subagentCount: Number(agents.get(thread.id)?.n ?? 0),
          backgroundTaskCount: Number(tasks.get(thread.id)?.n ?? 0),
        },
      }),
      thread.id,
    );
  }
  db.exec("INSERT INTO client_thread_migration VALUES (1)");
}
