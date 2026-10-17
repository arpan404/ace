import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import type { BrowserTabRecord, BrowserTabStore } from "@ace/browser";

const Row = z.object({
  tab_id: z.string().min(1).max(256),
  position: z.number().int().nonnegative(),
  url: z.string().max(8192),
  title: z.string().max(1024),
  label: z.string().max(64).nullable(),
  opened_by_kind: z.enum(["human", "agent", "page"]).nullable().catch(null),
  opened_by_agent: z.string().max(256).nullable(),
  last_active_at: z.number().int(),
});

/**
 * Thread tabs kept in the daemon database so a restarted daemon reopens them with the same ids
 * (ADR 0083). Cookies live in the browser profile; this keeps only addresses and who opened what.
 */
export class SqliteBrowserTabStore implements BrowserTabStore {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
    statement(`CREATE TABLE IF NOT EXISTS browser_tabs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      tab_id TEXT NOT NULL, position INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
      label TEXT, opened_by_kind TEXT, opened_by_agent TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'live', last_active_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, tab_id))`).run();
  }
  load(threadId: string): BrowserTabRecord[] {
    return this.statement(
      "SELECT tab_id, position, url, title, label, opened_by_kind, opened_by_agent, last_active_at FROM browser_tabs WHERE thread_id=? ORDER BY position",
    )
      .all(threadId)
      .flatMap((raw) => {
        // A row this build cannot read is skipped; the rest still come back.
        const row = Row.safeParse(raw);
        if (!row.success) return [];
        const { data } = row;
        return [
          {
            tabId: data.tab_id,
            position: data.position,
            url: data.url,
            title: data.title,
            ...(data.label ? { label: data.label } : {}),
            ...(data.opened_by_kind
              ? {
                  openedBy: {
                    kind: data.opened_by_kind,
                    ...(data.opened_by_agent ? { agentId: data.opened_by_agent } : {}),
                  },
                }
              : {}),
            lastActiveAt: data.last_active_at,
          },
        ];
      });
  }
  save(threadId: string, tabs: readonly BrowserTabRecord[]): void {
    this.statement("SAVEPOINT browser_tabs").run();
    try {
      this.statement("DELETE FROM browser_tabs WHERE thread_id=?").run(threadId);
      const insert = this.statement(
        "INSERT INTO browser_tabs (thread_id, tab_id, position, url, title, label, opened_by_kind, opened_by_agent, last_active_at) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const tab of tabs)
        insert.run(
          threadId,
          tab.tabId,
          tab.position,
          tab.url,
          tab.title,
          tab.label ?? null,
          tab.openedBy?.kind ?? null,
          tab.openedBy?.agentId ?? null,
          Math.trunc(tab.lastActiveAt),
        );
      this.statement("RELEASE browser_tabs").run();
    } catch (error) {
      this.statement("ROLLBACK TO browser_tabs").run();
      this.statement("RELEASE browser_tabs").run();
      throw error;
    }
  }
  clear(threadId: string): void {
    this.statement("DELETE FROM browser_tabs WHERE thread_id=?").run(threadId);
  }
}
