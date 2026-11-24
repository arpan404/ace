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
  /** A project's own threads: `<workspace> = ?`. */
  project: string;
  /** Every chat's threads but that project's own: `<workspace> IN (... chat, not ?)`. */
  chats: string;
  /** A window's project scope: the project's threads plus every chat's. */
  scoped: string;
  countedTerm: string;
  workspace: string;
  activity: string;
  id: string;
}
const threadSource = `${threadRowSource} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id=threads.id`;
/**
 * A project's scope terms (ADR 0099): its own threads, every chat's, and both together. The
 * page reads each separately; the counts and live threads may take the combined `IN` list.
 */
function projectSql(workspace: string) {
  return {
    project: `${workspace} = ?`,
    // The exclusion inside the subquery, so the chat arm stays an index search, never an OR scan.
    chats: `${workspace} IN (SELECT workspace_id FROM workspace_metadata WHERE kind = 'chat' AND workspace_id != ?)`,
    scoped: `${workspace} IN (SELECT ? UNION SELECT workspace_id FROM workspace_metadata WHERE kind = 'chat')`,
  };
}
function columnSql(archived: boolean): PageSql {
  return {
    source: `sidebar_thread_columns AS sidebar CROSS JOIN threads ON threads.id = sidebar.thread_id LEFT JOIN thread_cold AS cold ON cold.thread_id = threads.id LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id`,
    counted: "sidebar_thread_columns AS sidebar",
    visible: `sidebar.deleted = 0 AND sidebar.archived = ${archived ? 1 : 0}`,
    paged: archived ? "1" : "sidebar.settled = 1",
    active: archived ? "0" : "sidebar.settled = 0",
    ...projectSql("sidebar.workspace_id"),
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
    ...projectSql("workspace_id"),
    countedTerm: `(${sidebarCounted})`,
    workspace: "workspace_id",
    activity: archived ? "archived_at" : sidebarActivity,
    id: "id",
  };
}
/**
 * The page's rows. With no project it reads the list's own order straight from its index. A
 * strict project's page is that same read scoped to the project. A window carrying chats keeps
 * the project's read and adds a chat-only arm, each ordered and stopped at its own limit, so the
 * chat arm costs only chats. The outer query merges the two bounded arms; a chat's own project
 * is left out of the chat arm. Every arm selects the page's own projection (`columns`), so the
 * aliases the decoders read (`sidebar_revision`, `row_trusted`) survive the merge.
 */
function pageQuery(
  sql: PageSql,
  columns: string,
  project: string | undefined,
  withChats: boolean,
  cursor: string,
): string {
  const order = `${sql.activity} DESC, ${sql.id} ASC`;
  if (project === undefined)
    return `SELECT ${columns} FROM ${sql.source} WHERE ${sql.visible} AND ${sql.paged}${cursor} ORDER BY ${order} LIMIT ?`;
  if (!withChats)
    return `SELECT ${columns} FROM ${sql.source} WHERE ${sql.visible} AND ${sql.project} AND ${sql.paged}${cursor} ORDER BY ${order} LIMIT ?`;
  // Scope before cursor, so bound values are the project, the cursor's and the limit.
  const arm = (scope: string) =>
    `SELECT ${columns}, ${sql.activity} AS sidebar_order FROM ${sql.source} WHERE ${sql.visible} AND ${scope} AND ${sql.paged}${cursor} ORDER BY ${order} LIMIT ?`;
  return `SELECT * FROM (${arm(sql.project)}) UNION ALL SELECT * FROM (${arm(sql.chats)}) ORDER BY sidebar_order DESC, id ASC LIMIT ?`;
}
export function sidebarPageStorage(
  statement: (sql: string) => StatementSync,
  decode: (row: Record<string, SQLOutputValue>) => Thread,
  options: {
    limit: number;
    project?: string | undefined;
    archived?: boolean | undefined;
    withChats?: boolean | undefined;
  },
  before?: ThreadListCursor,
  reuse?: {
    entries: ReadonlyMap<string, ThreadListEntry>;
    changed: ReadonlySet<string>;
    current(entry: ThreadListEntry, revision: number): boolean;
  },
  summarize: (load: () => Summary) => Summary = (load) => load(),
): { threads: ThreadListEntry[]; window: ThreadListWindow } {
  const archived = options.archived === true;
  const withChats = options.withChats === true;
  const sql = sidebarColumnsReadable(statement) ? columnSql(archived) : expressionSql(archived);
  const scope = options.project ? ` AND ${withChats ? sql.scoped : sql.project}` : "";
  const matching = `${sql.visible}${scope}`;
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
  const limit = options.limit + 1;
  const cursor = before ? ` AND (${activity} < ? OR (${activity} = ? AND ${sql.id} > ?))` : "";
  const cursorParams = before ? [before.at, before.at, before.id] : [];
  const pageParams =
    options.project && withChats
      ? [options.project, ...cursorParams, limit, options.project, ...cursorParams, limit, limit]
      : options.project
        ? [options.project, ...cursorParams, limit]
        : [...cursorParams, limit];
  const rows = statement(pageQuery(sql, columns, options.project, withChats, cursor)).all(
    ...pageParams,
  );
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
