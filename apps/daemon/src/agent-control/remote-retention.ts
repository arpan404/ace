import { z } from "zod";
import type { Store } from "../store.ts";

const retentionMs = 7 * 24 * 60 * 60 * 1000;
/** Bounded maintenance. Live work and undelivered outcomes always keep their ownership rows. */
export function pruneRemoteRows(store: Store, now: number) {
  const cutoff = now - retentionMs;
  store.atomic((db) => {
    const exists = (table: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table);
    if (exists("remote_agent_tasks")) {
      const rows = db
        .prepare(`SELECT id FROM remote_agent_tasks WHERE terminal=1
        AND (NOT EXISTS (SELECT 1 FROM threads WHERE threads.id=parent_id AND json_extract(client,'$.deletedAt') IS NULL)
          OR (COALESCE(json_extract(record,'$.finishedAt'),json_extract(record,'$.createdAt'))<?
            AND NOT EXISTS (SELECT 1 FROM threads WHERE threads.id=root_id AND json_extract(status,'$.state') IN ('working','waiting')))) LIMIT 64`)
        .all(cutoff);
      for (const row of rows) {
        const id = z.string().parse(row.id);
        if (exists("remote_agent_returns"))
          db.prepare("DELETE FROM remote_agent_returns WHERE id=?").run(id);
        db.prepare("DELETE FROM remote_agent_tasks WHERE id=?").run(id);
      }
    }
    for (const table of [
      "remote_agent_publications",
      "remote_agent_context",
      "remote_agent_incoming",
    ]) {
      if (!exists(table)) continue;
      const thread =
        table === "remote_agent_incoming"
          ? "json_extract(record,'$.threadId')"
          : "json_extract(record,'$.task.threadId')";
      const deleted =
        table === "remote_agent_incoming"
          ? `json_extract(client,'$.deletedAt') IS NOT NULL AND updated_at<${cutoff} AND json_extract(status,'$.state') IN ('done','failed')`
          : "json_extract(client,'$.deletedAt') IS NOT NULL";
      // Updated time measures time since the last target turn, rather than the age of admission.
      db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE
        EXISTS (SELECT 1 FROM threads WHERE threads.id=${thread} AND (${deleted} OR (updated_at<? AND json_extract(status,'$.state') IN ('done','failed'))))
        OR (NOT EXISTS (SELECT 1 FROM threads WHERE threads.id=${thread}) AND COALESCE(json_extract(record,'$.task.createdAt'),json_extract(record,'$.createdAt'))<?) LIMIT 64)`).run(
        cutoff,
        cutoff,
      );
    }
  });
}
