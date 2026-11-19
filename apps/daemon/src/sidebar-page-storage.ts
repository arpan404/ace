import type { SQLOutputValue, StatementSync } from "node:sqlite";
import type { Thread, ThreadListCursor, ThreadListWindow, ThreadListEntry } from "@ace/protocol";
import { sidebarColumnsReadable } from "./sidebar-columns.ts";
import {
  sidebarActivity,
  sidebarCounted,
  sidebarDeleted,
  sidebarSettled,
} from "./sidebar-facts.ts";
import { threadRowColumns, threadRowSource } from "./thread-row.ts";
type Summary = Pick<ThreadListWindow, "total" | "counts">;

/** The SQL a page reads by: the facts' columns, or the facts evaluated from threads. */
interface PageSql {
  /** Rows to list, joined to their threads rows. */
  source: string;
  /** Rows to count, with no join. */
  counted: string;
  /** Not deleted, in the scope's archived state. */
  visible: string;
  /** Paged below the live threads, and live (above them). */
  paged: string;
  active: string;
  project: string;
  countedTerm: string;
  workspace: string;
  activity: string;
  id: string;
}
const threadSource = `${threadRowSource} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id=threads.id`;
function columnSql(archived: boolean): PageSql {
  return {
    source: `sidebar_thread_columns AS sidebar CROSS JOIN threads ON threads.id = sidebar.thread_id LEFT JOIN thread_cold AS cold ON cold.thread_id = threads.id LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id`,
    counted: "sidebar_thread_columns AS sidebar",
    visible: `sidebar.deleted = 0 AND sidebar.archived = ${archived ? 1 : 0}`,
    paged: archived ? "1" : "sidebar.settled = 1",
    active: archived ? "0" : "sidebar.settled = 0",
    project: "sidebar.workspace_id = ?",
    countedTerm: "sidebar.counted = 1",
    workspace: "sidebar.workspace_id",
    activity: archived ? "sidebar.archived_at" : "sidebar.activity",
    id: "sidebar.thread_id",
  };
}
function expressionSql(archived: boolean): PageSql {
  const paged = archived ? "1" : `(${sidebarSettled})`;
  return {
    source: threadSource,
    counted: "threads",
    visible: `NOT (${sidebarDeleted}) AND archived_at IS ${archived ? "NOT " : ""}NULL`,
    paged,
    active: `NOT (${paged})`,
    project: "workspace_id = ?",
    countedTerm: `(${sidebarCounted})`,
    workspace: "workspace_id",
    activity: archived ? "archived_at" : sidebarActivity,
    id: "id",
  };
}
export function sidebarPageStorage(
  statement: (sql: string) => StatementSync,
  decode: (row: Record<string, SQLOutputValue>) => Thread,
  options: { limit: number; project?: string | undefined; archived?: boolean | undefined },
  before?: ThreadListCursor,
  reuse?: {
    entries: ReadonlyMap<string, ThreadListEntry>;
    changed: ReadonlySet<string>;
    current(entry: ThreadListEntry, revision: number): boolean;
  },
  summarize: (load: () => Summary) => Summary = (load) => load(),
): { threads: ThreadListEntry[]; window: ThreadListWindow } {
  const archived = options.archived === true;
  const sql = sidebarColumnsReadable(statement) ? columnSql(archived) : expressionSql(archived);
  const matching = `${sql.visible}${options.project ? ` AND ${sql.project}` : ""}`;
  const params: string[] = options.project ? [options.project] : [];
  const { activity } = sql;
  // Live updates fetch membership and only changed/new payloads. A deeply paged window
  // must not deserialize every historical thread on each active-thread update.
  const columns = `${reuse ? "threads.id" : threadRowColumns}, COALESCE(revisions.revision, 0) AS sidebar_revision`;
  const entry = (row: Record<string, SQLOutputValue>): ThreadListEntry => {
    const id = String(row.id);
    const retained = reuse?.entries.get(id);
    if (
      retained &&
      !reuse?.changed.has(id) &&
      reuse?.current(retained, Number(row.sidebar_revision))
    )
      return retained;
    if (!reuse) return decode(row);
    const full = statement(
      `SELECT ${threadRowColumns}, COALESCE(revisions.revision, 0) AS sidebar_revision FROM ${threadSource} WHERE threads.id = ?`,
    ).get(id);
    if (!full) throw new Error("Sidebar membership changed within a read");
    return decode(full);
  };
  const rows = statement(
    `SELECT ${columns} FROM ${sql.source} WHERE ${matching} AND ${sql.paged}${before ? ` AND (${activity} < ? OR (${activity} = ? AND ${sql.id} > ?))` : ""} ORDER BY ${activity} DESC, ${sql.id} ASC LIMIT ?`,
  ).all(...params, ...(before ? [before.at, before.at, before.id] : []), options.limit + 1);
  const page = rows.slice(0, options.limit).map(entry);
  const active = before
    ? []
    : statement(
        `SELECT ${columns} FROM ${sql.source} WHERE ${matching} AND ${sql.active} ORDER BY ${activity} DESC, ${sql.id} ASC`,
      )
        .all(...params)
        .map(entry);
  const { total, counts } = summarize(() => {
    const totalCount = Number(
      statement(`SELECT COUNT(*) AS n FROM ${sql.counted} WHERE ${matching} AND ${sql.paged}`).get(
        ...params,
      )?.n ?? 0,
    );
    const projectCounts = statement(
      `SELECT ${sql.workspace} AS id, COUNT(*) AS threads FROM ${sql.counted} WHERE ${sql.visible} AND ${sql.countedTerm} GROUP BY ${sql.workspace} ORDER BY ${sql.workspace}`,
    )
      .all()
      .map((row) => ({ id: String(row.id), threads: Number(row.threads) }));
    return { total: totalCount, counts: projectCounts };
  });
  const last = page.at(-1);
  // Read in the same snapshot as the rows: every row here has this revision or an older one.
  const revision = Number(
    statement("SELECT COALESCE(MAX(revision), 0) AS newest FROM sidebar_thread_revisions").get()
      ?.newest ?? 0,
  );
  return {
    threads: [...active, ...page],
    window: {
      before: rows.length > options.limit && last ? sidebarCursor(last, options.archived) : null,
      total,
      counts,
      revision,
    },
  };
}
/** Where the next page starts: after this, the page's last entry. */
export function sidebarCursor(
  last: ThreadListEntry,
  archived: boolean | undefined,
): ThreadListCursor {
  return {
    at: archived ? (last.archivedAt ?? last.updatedAt) : (last.activityAt ?? last.updatedAt),
    id: last.id,
  };
}
