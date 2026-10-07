import { Item, StepMeasurement, type EventPayload, type ThreadId } from "@ace/protocol";
import type { StatementSync, DatabaseSync } from "node:sqlite";
import { measurementCall } from "./measurement-correlation.ts";

/** Indexed daemon evidence survives provider upserts and daemon restarts. */
export class MeasurementStore {
  private sql: (query: string) => StatementSync;
  constructor(db: DatabaseSync, sql: (query: string) => StatementSync) {
    this.sql = sql;
    db.exec(`CREATE TABLE IF NOT EXISTS measurement_tools (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, seq INTEGER NOT NULL,
      started INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS measurement_tool_match ON measurement_tools(thread_id,name,args,started,seq);
      CREATE TABLE IF NOT EXISTS step_measurements (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER NOT NULL, since_seq INTEGER NOT NULL,
      item_id TEXT UNIQUE, bound_id TEXT, measurement JSON NOT NULL, filmstrip TEXT);
      CREATE INDEX IF NOT EXISTS measurement_pending ON step_measurements(thread_id,name,args,finished) WHERE item_id IS NULL;
      CREATE INDEX IF NOT EXISTS measurement_lease ON step_measurements(session_id,name,args) WHERE item_id IS NULL;
      CREATE INDEX IF NOT EXISTS measurement_attachment ON step_measurements(thread_id,filmstrip);`);
  }
  decorate(thread: ThreadId, payload: EventPayload, seq: number): EventPayload {
    if (payload.type !== "item.created" && payload.type !== "item.updated") return payload;
    if (payload.item.type !== "tool_call") return payload;
    const match = measurementCall(payload.item);
    if (match)
      this.sql(`INSERT INTO measurement_tools VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET name=excluded.name,args=excluded.args,status=excluded.status`).run(
        payload.item.id,
        thread,
        payload.item.agentId,
        match.name,
        match.key,
        seq,
        match.call.startedAt,
        match.call.status,
      );
    const row = this.sql(
      "SELECT measurement FROM step_measurements WHERE thread_id=? AND item_id=?",
    ).get(thread, payload.item.id);
    if (row)
      return {
        ...payload,
        item: {
          ...payload.item,
          measurement: StepMeasurement.parse(JSON.parse(String(row.measurement))),
        },
      };
    return payload;
  }
  retains(thread: string, hash: string): boolean {
    return Boolean(
      this.sql("SELECT 1 FROM step_measurements WHERE thread_id=? AND filmstrip=? LIMIT 1").get(
        thread,
        hash,
      ),
    );
  }
  candidates(
    thread: string,
    name: string,
    args: string,
    since: number,
    started: number,
    finished: number,
  ) {
    return this.sql(`SELECT t.id FROM measurement_tools t WHERE thread_id=? AND name=? AND args=?
      AND seq>? AND started BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM step_measurements m WHERE m.item_id=t.id)
      ORDER BY seq LIMIT 2`).all(thread, name, args, since, started - 90_000, finished + 5000);
  }
  running(thread: string, name: string, args: string, since: number, at: number) {
    return this.sql(`SELECT id FROM measurement_tools t WHERE thread_id=? AND name=? AND args=? AND seq>?
      AND started BETWEEN ? AND ? AND status IN ('pending','running')
      AND NOT EXISTS(SELECT 1 FROM step_measurements m WHERE m.item_id=t.id) LIMIT 2`).all(
      thread,
      name,
      args,
      since,
      at - 90_000,
      at,
    );
  }
  item(thread: ThreadId, id: string) {
    const row = this.sql("SELECT item FROM items WHERE thread_id=? AND id=?").get(thread, id);
    return row ? Item.parse(JSON.parse(String(row.item))) : undefined;
  }
}
