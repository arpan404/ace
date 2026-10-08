import { HistorySession } from "@ace/protocol/history";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { sessionTitle } from "./user-text.ts";

/** Import includes the whole provider tree, so a readable root with an unreadable child cannot open. */
export const blockedDescendant = `WITH RECURSIVE tree(id,native) AS (
  SELECT id,native FROM visible_sources WHERE instance=sources.instance AND parent=sources.native
  UNION SELECT child.id,child.native FROM visible_sources child JOIN tree ON child.parent=tree.native WHERE child.instance=sources.instance LIMIT 513
) SELECT json_extract(s.summary,'$.support.reason') FROM tree JOIN visible_sources s ON s.id=tree.id WHERE json_extract(s.summary,'$.support.status')='unsupported' LIMIT 1`;

export function catalogDisplay(db: DatabaseSync) {
  const name = db.prepare("SELECT title FROM native_titles WHERE instance=? AND native=?");
  const blocked = db.prepare(
    `SELECT (${blockedDescendant}) AS reason FROM visible_sources sources WHERE id=?`,
  );
  return (json: string): HistorySession => {
    const summary = HistorySession.parse(JSON.parse(json));
    const title = name.get(summary.instanceId, summary.nativeId)?.title;
    const reason = blocked.get(summary.id)?.reason;
    return {
      ...summary,
      title: sessionTitle(
        typeof title === "string" && title !== summary.nativeId
          ? title
          : summary.title === summary.nativeId
            ? ""
            : summary.title,
        summary.title === summary.nativeId ? "" : summary.title,
        summary.lastActivity,
      ),
      ...(typeof reason === "string"
        ? {
            support: {
              status: "unsupported" as const,
              reason: "Part of this session's history can't be opened. " + reason,
            },
          }
        : {}),
    };
  };
}
