import { z } from "zod";
import { normalizeAceCall, aceToolInput } from "@ace/core";
import { ToolCall, ToolResult, type EventPayload, type ThreadId } from "@ace/protocol";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { argumentKey } from "./measurement-correlation.ts";

/** Indexed evidence is independent of adapter snapshots and retained across restart. */
export class ToolResultStore {
  private sql: (query: string) => StatementSync;
  constructor(db: DatabaseSync, sql: (query: string) => StatementSync) {
    this.sql = sql;
    db.exec(`CREATE TABLE IF NOT EXISTS ace_tools (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, seq INTEGER NOT NULL,
      started INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ace_tool_match ON ace_tools(thread_id,agent_id,name,args,seq);
      CREATE TABLE IF NOT EXISTS ace_results (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER, since_seq INTEGER NOT NULL,
      item_id TEXT UNIQUE, bound_id TEXT, result JSON, notice_id TEXT);
      CREATE INDEX IF NOT EXISTS ace_result_pending ON ace_results(thread_id,agent_id,name,args,finished) WHERE item_id IS NULL;
      CREATE INDEX IF NOT EXISTS ace_result_session ON ace_results(session_id,name,args) WHERE item_id IS NULL;
      CREATE TABLE IF NOT EXISTS ace_result_images (
      result_id TEXT NOT NULL REFERENCES ace_results(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, hash TEXT NOT NULL,
      PRIMARY KEY(result_id,hash));
      CREATE INDEX IF NOT EXISTS ace_result_image ON ace_result_images(thread_id,hash);`);
  }
  decorate(thread: ThreadId, payload: EventPayload, seq: number): EventPayload {
    if (payload.type !== "item.created" && payload.type !== "item.updated") return payload;
    if (payload.item.type !== "tool_call") return payload;
    const call = ToolCall.parse(normalizeAceCall(payload.item.call));
    const match = aceToolInput(call);
    if (!match) return payload;
    this.sql(`INSERT INTO ace_tools VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET name=excluded.name,args=excluded.args,status=excluded.status`).run(
      call.id,
      thread,
      call.agentId,
      match.name,
      argumentKey(match.input),
      seq,
      call.startedAt,
      call.status,
    );
    const row = this.sql(
      "SELECT result,finished FROM ace_results WHERE thread_id=? AND item_id=? AND result IS NOT NULL",
    ).get(thread, call.id);
    if (!row) return { ...payload, item: { ...payload.item, call } };
    const result = ToolResult.parse(JSON.parse(String(row.result)));
    const text = result.content.find((part) => part.type === "text");
    let error = text?.type === "text" ? text.text : "Ace tool failed";
    try {
      const parsed = z
        .object({ message: z.string().max(4096), detail: z.string().max(256).optional() })
        .safeParse(JSON.parse(error));
      if (parsed.success)
        error = parsed.data.detail
          ? `${parsed.data.message}: ${parsed.data.detail}`
          : parsed.data.message;
    } catch {
      /* Registry failures are plain text. */
    }
    return {
      ...payload,
      item: {
        ...payload.item,
        call: {
          ...call,
          result,
          ...(payload.item.complete
            ? {
                endedAt: Number(row.finished),
                ...(result.isError
                  ? {
                      status: "failed",
                      error,
                    }
                  : {}),
              }
            : {}),
        },
      },
    };
  }
  retains(thread: string, hash: string): boolean {
    return Boolean(
      this.sql("SELECT 1 FROM ace_result_images WHERE thread_id=? AND hash=? LIMIT 1").get(
        thread,
        hash,
      ),
    );
  }
}
