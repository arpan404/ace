import { HistorySession } from "@ace/protocol/history";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { sessionTitle } from "./user-text.ts";

/** Prefer a readable native source, then full file history, recency and a stable tie-break. */
export function preferredDuplicate(source: "sources" | "child"): string {
  return `SELECT 1 FROM visible_sources preferred
  WHERE preferred.instance=${source}.instance AND preferred.native=${source}.native AND preferred.cwd=${source}.cwd AND preferred.hidden=0
  AND (CASE WHEN json_extract(preferred.summary,'$.support.status')='supported' THEN 0 ELSE 1 END,
       CASE preferred.kind WHEN 'jsonl' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END,-preferred.activity,preferred.id)
    < (CASE WHEN json_extract(${source}.summary,'$.support.status')='supported' THEN 0 ELSE 1 END,
       CASE ${source}.kind WHEN 'jsonl' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END,-${source}.activity,${source}.id)`;
}

/** Import includes the whole provider tree, so a readable root with an unreadable child cannot open. */
export const blockedDescendant = `WITH RECURSIVE tree(id,native) AS (
  SELECT child.id,child.native FROM visible_sources child WHERE child.instance=sources.instance AND child.parent=sources.native AND child.hidden=0 AND NOT EXISTS (${preferredDuplicate("child")})
  UNION SELECT child.id,child.native FROM visible_sources child JOIN tree ON child.parent=tree.native WHERE child.instance=sources.instance AND child.hidden=0 AND NOT EXISTS (${preferredDuplicate("child")}) LIMIT 513
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
        typeof title === "string" && title !== summary.nativeId ? title : "",
        // The scanner already distinguished provider labels from the person's real prompt.
        summary.title,
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
