import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import type { BrowserTabRecord, EngineMoveJournal } from "@ace/browser";

const Tab = z.object({
  tabId: z.string().min(1).max(256),
  position: z.number().int().nonnegative(),
  url: z.string().max(8192),
  title: z.string().max(1024),
  label: z.string().max(64).optional(),
  openedBy: z
    .object({
      kind: z.enum(["human", "agent", "page"]),
      agentId: z.string().max(256).optional(),
    })
    .optional()
    .catch(undefined),
  private: z.boolean().optional(),
  kept: z.boolean().optional(),
  lastActiveAt: z.number().int(),
});
const Tabs = z.array(Tab).max(512);

/**
 * The tabs an engine move carries (ADR 0194), kept in the daemon database until the move
 * settles, so a daemon that stops mid-move reopens all of them. One row per thread with a move
 * under way; a deleted thread takes its row with it.
 */
export class SqliteEngineMoveJournal implements EngineMoveJournal {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
    statement(`CREATE TABLE IF NOT EXISTS browser_engine_moves (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      tabs TEXT NOT NULL)`).run();
  }
  begin(threadId: string, tabs: readonly BrowserTabRecord[]): void {
    // An outside MCP client's session (ADR 0122) has no thread row and nothing to restore.
    if (!this.statement("SELECT 1 FROM threads WHERE id=?").get(threadId)) return;
    this.statement(
      "INSERT INTO browser_engine_moves (thread_id, tabs) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET tabs=excluded.tabs",
    ).run(threadId, JSON.stringify(tabs));
  }
  pending(threadId: string): BrowserTabRecord[] | undefined {
    const row = this.statement("SELECT tabs FROM browser_engine_moves WHERE thread_id=?").get(
      threadId,
    );
    if (typeof row?.["tabs"] !== "string") return undefined;
    // A row another build wrote and this one can't read restores nothing rather than failing.
    try {
      const parsed = Tabs.safeParse(JSON.parse(row["tabs"]));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  end(threadId: string): void {
    this.statement("DELETE FROM browser_engine_moves WHERE thread_id=?").run(threadId);
  }
}
