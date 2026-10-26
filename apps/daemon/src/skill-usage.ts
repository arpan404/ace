import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ThreadId, type Item } from "@ace/protocol";

/**
 * One row per (user message, mentioned skill), so the Skills page reads counts with one indexed
 * query instead of scanning history. Rows go with their message (and thread) through the items
 * foreign key. The backfill runs once, in the migration that creates the table.
 */
export const skillUsageTable = `CREATE TABLE IF NOT EXISTS skill_usage (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(item_id, name)
  );
  CREATE INDEX IF NOT EXISTS skill_usage_name_at ON skill_usage(name, at);
  INSERT OR IGNORE INTO skill_usage
    SELECT items.id, items.thread_id, json_extract(part.value, '$.name'),
      COALESCE(json_extract(items.item, '$.createdAt'), 0)
    FROM items, json_each(items.item, '$.parts') AS part
    WHERE json_extract(items.item, '$.type') = 'message'
      AND json_extract(items.item, '$.role') = 'user'
      AND COALESCE(json_extract(items.item, '$.synthetic'), 0) = 0
      AND json_extract(items.item, '$.inherited') IS NULL
      AND json_extract(part.value, '$.type') = 'mention'
      AND json_extract(part.value, '$.kind') = 'skill'
      AND typeof(json_extract(part.value, '$.name')) = 'text';`;

/** Skills a person picked in their own message; fork copies and synthetic messages don't count. */
function mentionedSkills(item: Item): string[] {
  if (item.type !== "message" || item.role !== "user" || item.synthetic || item.inherited)
    return [];
  return [
    ...new Set(
      item.parts.flatMap((part) =>
        part.type === "mention" && part.kind === "skill" ? [part.name] : [],
      ),
    ),
  ];
}
export function recordSkillUsage(
  statement: (sql: string) => StatementSync,
  threadId: ThreadId,
  item: Item,
): void {
  for (const name of mentionedSkills(item))
    statement("INSERT OR IGNORE INTO skill_usage VALUES (?, ?, ?, ?)").run(
      item.id,
      threadId,
      name,
      item.createdAt,
    );
}
const Count = z.object({ count: z.number(), at: z.number() });
const Last = z.object({ thread_id: ThreadId, title: z.string(), at: z.number() });
/** Count and most recent thread per skill name: two indexed lookups per name. */
export function readSkillUsage(
  statement: (sql: string) => StatementSync,
  names: readonly string[],
): Map<string, { count: number; last?: { threadId: ThreadId; title: string; at: number } }> {
  const out = new Map<
    string,
    { count: number; last?: { threadId: ThreadId; title: string; at: number } }
  >();
  for (const name of new Set(names)) {
    const count = Count.safeParse(
      statement(
        "SELECT COUNT(*) AS count, COALESCE(MAX(at), 0) AS at FROM skill_usage WHERE name = ?",
      ).get(name),
    );
    if (!count.success || count.data.count === 0) continue;
    const last = Last.safeParse(
      statement(
        `SELECT u.thread_id, t.title, u.at FROM skill_usage u JOIN threads t ON t.id = u.thread_id
         WHERE u.name = ? ORDER BY u.at DESC LIMIT 1`,
      ).get(name),
    );
    out.set(name, {
      count: count.data.count,
      ...(last.success
        ? { last: { threadId: last.data.thread_id, title: last.data.title, at: last.data.at } }
        : {}),
    });
  }
  return out;
}
