import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Database } from "@ace/provider-kit/sqlite";
import type { UsageUpdated } from "@ace/protocol";
import type { UsageEvent } from "./events.ts";

export { UsageSessionTotal as SessionTotal } from "@ace/protocol";
import {
  UsageSessionTotalPage as SessionTotalPage,
  UsageSessionTotalsQuery as SessionTotalsRequest,
} from "@ace/protocol";
export { SessionTotalPage, SessionTotalsRequest };
const ColumnInfo = z.object({ name: z.string() });
/** Inclusive estimates retain inherited baselines without contributing to agent/day rollups. */
export class SessionTotals {
  private readonly upsert;
  private readonly read;
  private readonly remove;
  constructor(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_session_totals (
      thread TEXT NOT NULL, counter_key TEXT NOT NULL, scope TEXT NOT NULL, model TEXT NOT NULL,
      at INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL,
      write INTEGER NOT NULL, cost REAL NOT NULL, write1h INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(thread, counter_key, scope, model));
      CREATE INDEX IF NOT EXISTS usage_session_thread ON usage_session_totals(thread, at);`);
    if (
      ![...db.prepare("PRAGMA table_info(usage_session_totals)").iterate()].some(
        (row) => ColumnInfo.parse(row).name === "write1h",
      )
    )
      db.exec("ALTER TABLE usage_session_totals ADD COLUMN write1h INTEGER NOT NULL DEFAULT 0");
    this.upsert =
      db.prepare(`INSERT INTO usage_session_totals(thread,counter_key,scope,model,at,input,output,cached,write,cost,write1h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread,counter_key,scope,model) DO UPDATE SET
      at=MAX(at,excluded.at), input=MAX(input,excluded.input), output=MAX(output,excluded.output),
      cached=MAX(cached,excluded.cached), write=MAX(write,excluded.write), cost=MAX(cost,excluded.cost), write1h=MAX(write1h,excluded.write1h)`);
    this.read = db.prepare(`SELECT counter_key AS counterKey, scope, model, at,
      input AS inputTokens, output AS outputTokens, cached AS cachedInputTokens,
      write AS cacheWriteTokens, write1h AS cacheWrite1hTokens, cost AS costUsd FROM usage_session_totals
      WHERE thread=? ORDER BY at DESC, counter_key, scope, model LIMIT ?`);
    this.remove = db.prepare("DELETE FROM usage_session_totals WHERE thread=?");
  }
  observe(
    thread: string,
    at: number,
    usage: Omit<UsageUpdated, "model" | "agentId"> & { model?: string | null | undefined },
  ): void {
    if (!usage.counterKey) throw new Error("Inclusive usage snapshot requires a counter key");
    this.upsert.run(
      thread,
      usage.counterKey,
      usage.usageScope ?? "provider_session",
      usage.model ?? "",
      at,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
      usage.costUsd ?? 0,
      usage.cacheWrite1hTokens ?? 0,
    );
  }
  list(input: unknown) {
    const { thread, limit } = SessionTotalsRequest.parse(input);
    return SessionTotalPage.parse(this.read.all(thread, limit));
  }
  delete(thread: string): void {
    this.remove.run(thread);
  }
}

/**
 * One thread's inclusive totals from its own compact samples, by the rule the projection keeps
 * (`observe` per sample, then `list`), in a database that lives for this call. Bounded by the
 * thread, not history, and it writes nothing, so it can answer while the replay is behind.
 */
export function sessionTotalsFrom(events: Iterable<UsageEvent>, query: unknown) {
  const request = SessionTotalsRequest.parse(query);
  const db = new Database(":memory:");
  try {
    const totals = new SessionTotals(db);
    for (const { threadId, at, payload } of events)
      if (
        threadId === request.thread &&
        payload.type === "usage.updated" &&
        (payload.usageScope === "provider_session" || payload.usageScope === "model_session")
      )
        totals.observe(threadId, at, payload);
    return totals.list(request);
  } finally {
    db.close();
  }
}
