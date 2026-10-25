import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { SidebarIndex, type SidebarFacts } from "./sidebar-index.ts";
import {
  sidebarActivity,
  sidebarCounted,
  sidebarDeleted,
  sidebarSettled,
} from "./sidebar-page-storage.ts";

const facts = `SELECT threads.id AS id, COALESCE(revisions.revision, 0) AS revision, workspace_id AS workspace, (${sidebarDeleted}) AS deleted, archived_at IS NOT NULL AS archived, CASE WHEN (${sidebarSettled}) THEN 1 WHEN NOT (${sidebarSettled}) THEN 0 END AS settled, CASE WHEN (${sidebarCounted}) THEN 1 ELSE 0 END AS counted, ${sidebarActivity} AS activity, archived_at AS archived_at`;

/**
 * The sidebar index kept current from the threads table itself. Each sync reads only rows
 * whose revision moved past the last one seen, so direct SQL writes count even without an
 * event. A delete (rare) rebuilds it. Callers sync only inside a read snapshot of committed
 * data: committed revisions are never reused, so nothing a rollback undoes is ever seen.
 */
export class SidebarLive {
  readonly index = new SidebarIndex();
  private seen: number | undefined;
  private deletes: SQLOutputValue = null;
  private readonly statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /** Bring the index up to the snapshot being read. */
  sync(): void {
    const deletes =
      this.statement("SELECT count FROM sidebar_thread_deletes WHERE id = 1").get()?.count ?? null;
    if (this.seen === undefined || deletes !== this.deletes) {
      this.rebuild(deletes);
      return;
    }
    const rows = this.statement(
      `${facts} FROM sidebar_thread_revisions AS revisions JOIN threads ON threads.id = revisions.thread_id WHERE revisions.revision > ? ORDER BY revisions.revision`,
    ).all(this.seen);
    for (const row of rows) {
      const next = decodeFacts(row);
      this.index.put(next);
      this.seen = Math.max(this.seen, next.revision);
    }
  }
  /** Forget everything; the next sync reads every row again. */
  reset(): void {
    this.seen = undefined;
    this.index.clear();
  }
  private rebuild(deletes: SQLOutputValue): void {
    let seen = 0;
    const all = this.statement(
      `${facts} FROM threads LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id`,
    )
      .all()
      .map((row) => {
        const next = decodeFacts(row);
        seen = Math.max(seen, next.revision);
        return next;
      });
    this.index.load(all);
    this.seen = seen;
    this.deletes = deletes;
  }
}

function decodeFacts(row: Record<string, SQLOutputValue>): SidebarFacts {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    workspace: row.workspace ?? null,
    deleted: row.deleted === 1,
    archived: row.archived === 1,
    settled: row.settled === 1 ? true : row.settled === 0 ? false : null,
    counted: row.counted === 1,
    activity: row.activity ?? null,
    archivedAt: row.archived_at ?? null,
  };
}
