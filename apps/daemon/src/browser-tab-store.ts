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
  private: z.number().int().catch(0),
  kept: z.number().int().catch(0),
  last_active_at: z.number().int(),
});

/**
 * Thread tabs kept in the daemon database so a restarted daemon reopens them with the same ids
 * (ADR 0083). Cookies live in the browser profile; this keeps only addresses and who opened what.
 */
export class SqliteBrowserTabStore implements BrowserTabStore {
  private statement: (sql: string) => StatementSync;
  private table: string;
  /** `table`: ace's own browsers keep `browser_tabs`; the person's Chrome keeps its own. */
  constructor(
    statement: (sql: string) => StatementSync,
    table: "browser_tabs" | "user_browser_tabs" = "browser_tabs",
  ) {
    this.statement = statement;
    this.table = table;
    // Tab records are only restore hints: a table from an earlier build is rebuilt empty
    // rather than migrated, so a private tab can never come back unmarked.
    const columns = statement(`SELECT name FROM pragma_table_info('${table}')`).all();
    if (columns.length && !columns.some((column) => column["name"] === "kept"))
      statement(`DROP TABLE ${table}`).run();
    statement(`CREATE TABLE IF NOT EXISTS ${table} (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      tab_id TEXT NOT NULL, position INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
      label TEXT, opened_by_kind TEXT, opened_by_agent TEXT,
      private INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0,
      lifecycle TEXT NOT NULL DEFAULT 'live', last_active_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, tab_id))`).run();
  }
  load(threadId: string): BrowserTabRecord[] {
    return this.statement(
      `SELECT tab_id, position, url, title, label, opened_by_kind, opened_by_agent, private, kept, last_active_at FROM ${this.table} WHERE thread_id=? ORDER BY position`,
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
            ...(data.private ? { private: true } : {}),
            ...(data.kept ? { kept: true } : {}),
            lastActiveAt: data.last_active_at,
          },
        ];
      });
  }
  save(threadId: string, tabs: readonly BrowserTabRecord[]): void {
    this.statement(`SAVEPOINT ${this.table}`).run();
    try {
      this.statement(`DELETE FROM ${this.table} WHERE thread_id=?`).run(threadId);
      const insert = this.statement(
        `INSERT INTO ${this.table} (thread_id, tab_id, position, url, title, label, opened_by_kind, opened_by_agent, private, kept, last_active_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
          tab.private ? 1 : 0,
          tab.kept ? 1 : 0,
          Math.trunc(tab.lastActiveAt),
        );
      this.statement(`RELEASE ${this.table}`).run();
    } catch (error) {
      this.statement(`ROLLBACK TO ${this.table}`).run();
      this.statement(`RELEASE ${this.table}`).run();
      throw error;
    }
  }
  clear(threadId: string): void {
    this.statement(`DELETE FROM ${this.table} WHERE thread_id=?`).run(threadId);
  }
}
