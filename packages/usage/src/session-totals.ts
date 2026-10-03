import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { UsageUpdated } from "@ace/protocol";

export const SessionTotal = z.object({
  counterKey: z.string(),
  scope: z.enum(["provider_session", "model_session"]),
  model: z.string(),
  at: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});
export const SessionTotalPage = z.array(SessionTotal).max(100);
export const SessionTotalsRequest = z.object({
  thread: z.string().min(1).max(8192),
  limit: z.number().int().min(1).max(100).default(100),
});
/** Inclusive estimates retain inherited baselines without contributing to agent/day rollups. */
export class SessionTotals {
  private readonly upsert;
  private readonly read;
  private readonly remove;
  constructor(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_session_totals (
      thread TEXT NOT NULL, counter_key TEXT NOT NULL, scope TEXT NOT NULL, model TEXT NOT NULL,
      at INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL,
      write INTEGER NOT NULL, cost REAL NOT NULL,
      PRIMARY KEY(thread, counter_key, scope, model));
      CREATE INDEX IF NOT EXISTS usage_session_thread ON usage_session_totals(thread, at);`);
    this.upsert = db.prepare(`INSERT INTO usage_session_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread,counter_key,scope,model) DO UPDATE SET
      at=MAX(at,excluded.at), input=MAX(input,excluded.input), output=MAX(output,excluded.output),
      cached=MAX(cached,excluded.cached), write=MAX(write,excluded.write), cost=MAX(cost,excluded.cost)`);
    this.read = db.prepare(`SELECT counter_key AS counterKey, scope, model, at,
      input AS inputTokens, output AS outputTokens, cached AS cachedInputTokens,
      write AS cacheWriteTokens, cost AS costUsd FROM usage_session_totals
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
