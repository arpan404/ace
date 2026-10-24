import type { SQLOutputValue, StatementSync } from "node:sqlite";
import type { Thread, ThreadListCursor, ThreadListWindow, ThreadListEntry } from "@ace/protocol";
import { threadRowColumns, threadRowSource } from "./thread-row.ts";
type Summary = Pick<ThreadListWindow, "total" | "counts">;
/** Counted in project totals: not an unsent draft. */
export const sidebarCounted =
  "COALESCE(json_extract(client, '$.hasSentMessage'), 1) != 0 AND NOT (json_extract(client, '$.hasSentMessage') IS NULL AND json_extract(status, '$.state') = 'new' AND title = 'New thread')";
// Queue attention and settled membership exactly match projection.sidebarSettled.
const attention =
  "COALESCE(json_extract(provider_metadata, '$.queue.paused'), 0) = 1 AND json_extract(provider_metadata, '$.queue.resumeAt') IS NULL AND json_extract(provider_metadata, '$.queue.reason') IS NOT NULL AND json_extract(provider_metadata, '$.queue.reason') NOT IN ('limit', 'snooze') AND NOT (json_extract(provider_metadata, '$.queue.reason') = 'manual' AND COALESCE(json_extract(provider_metadata, '$.queue.pendingCount'), 0) = 0)";
/** Paged with the history below the live threads; may be NULL, which is neither. */
export const sidebarSettled = `COALESCE(json_extract(client, '$.pinned'), 0) != 1 AND json_extract(client, '$.settledAt') IS NOT NULL AND json_extract(status, '$.state') NOT IN ('working', 'needs_you') AND (COALESCE(json_extract(client, '$.settledReason'), '') = 'manual' OR NOT (${attention}))`;
export const sidebarDeleted = "json_extract(client, '$.deletedAt') IS NOT NULL";
export const sidebarActivity = "COALESCE(json_extract(client, '$.activityAt'), updated_at)";
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
  const draft = sidebarCounted;
  const visible = `NOT (${sidebarDeleted}) AND archived_at IS ${options.archived ? "NOT " : ""}NULL`;
  const paged = options.archived ? "1" : `(${sidebarSettled})`;
  const matching = `${visible}${options.project ? " AND workspace_id = ?" : ""}`;
  const params: string[] = options.project ? [options.project] : [];
  const activity = options.archived ? "archived_at" : sidebarActivity;
  // Live updates fetch membership and only changed/new payloads. A deeply paged window
  // must not deserialize every historical thread on each active-thread update.
  const columns = `${reuse ? "threads.id" : threadRowColumns}, COALESCE(revisions.revision, 0) AS sidebar_revision`;
  const source = `${threadRowSource} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id=threads.id`;
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
      `SELECT ${threadRowColumns}, COALESCE(revisions.revision, 0) AS sidebar_revision FROM ${source} WHERE threads.id = ?`,
    ).get(id);
    if (!full) throw new Error("Sidebar membership changed within a read");
    return decode(full);
  };
  const rows = statement(
    `SELECT ${columns} FROM ${source} WHERE ${matching} AND ${paged}${before ? ` AND (${activity} < ? OR (${activity} = ? AND id > ?))` : ""} ORDER BY ${activity} DESC, id ASC LIMIT ?`,
  ).all(...params, ...(before ? [before.at, before.at, before.id] : []), options.limit + 1);
  const page = rows.slice(0, options.limit).map(entry);
  const active = before
    ? []
    : statement(
        `SELECT ${columns} FROM ${source} WHERE ${matching} AND NOT (${paged}) ORDER BY ${activity} DESC, id ASC`,
      )
        .all(...params)
        .map(entry);
  const { total, counts } = summarize(() => {
    const totalCount = Number(
      statement(`SELECT COUNT(*) AS n FROM threads WHERE ${matching} AND ${paged}`).get(...params)
        ?.n ?? 0,
    );
    const projectCounts = statement(
      `SELECT workspace_id AS id, COUNT(*) AS threads FROM threads WHERE ${visible} AND (${draft}) GROUP BY workspace_id ORDER BY workspace_id`,
    )
      .all()
      .map((row) => ({ id: String(row.id), threads: Number(row.threads) }));
    return { total: totalCount, counts: projectCounts };
  });
  const last = page.at(-1);
  return {
    threads: [...active, ...page],
    window: {
      before: rows.length > options.limit && last ? sidebarCursor(last, options.archived) : null,
      total,
      counts,
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
