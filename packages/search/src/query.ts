import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { SearchQuery, SearchResults, SearchSnippet } from "@ace/protocol";
import { matchExpression } from "./text.ts";
import type { Statements } from "./writer.ts";

const Cursor = z.object({
  generation: z.number().int().nonnegative(),
  fingerprint: z.string().length(64),
  score: z.number().finite(),
  id: z.number().int().positive(),
});
const Row = z.object({
  id: z.number(),
  thread: z.string(),
  item: z.string(),
  agent: z.string().nullable(),
  kind: z.string(),
  at: z.number(),
  threadTitle: z.string(),
  workspace: z.string(),
  provider: z.string(),
  status: z.string(),
  score: z.number(),
  titleSnippet: z.string(),
  bodySnippet: z.string(),
});
function snippet(marked: string): z.infer<typeof SearchSnippet> {
  let text = "";
  let start: number | undefined;
  const highlights: { start: number; end: number }[] = [];
  for (let i = 0; i < marked.length && text.length < 4096; i++) {
    const char = marked[i];
    if (char === "\u0001") start = text.length;
    else if (char === "\u0002") {
      if (start !== undefined && highlights.length < 256)
        highlights.push({ start, end: text.length });
      start = undefined;
    } else text += char;
  }
  if (start !== undefined && highlights.length < 256) highlights.push({ start, end: text.length });
  return { text, highlights };
}
export function querySearch(
  sql: Statements,
  input: unknown,
  generation: number,
  trigrams: boolean,
): SearchResults {
  const parsed = SearchQuery.safeParse(input);
  if (!parsed.success) throw new Error("search_invalid_query");
  const q = parsed.data;
  const text = q.text.trim();
  if (!text && q.scope !== "threads") throw new Error("search_invalid_query");
  if (q.mode === "substring" && !trigrams) throw new Error("search_invalid_query");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ text, mode: q.mode, scope: q.scope, filters: q.filters }))
    .digest("hex");
  let cursor: z.infer<typeof Cursor> | undefined;
  if (q.cursor) {
    try {
      cursor = Cursor.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
    } catch {
      throw new Error("search_invalid_query");
    }
    if (cursor.fingerprint !== fingerprint) throw new Error("search_invalid_query");
    if (cursor.generation !== generation) throw new Error("search_cursor_stale");
  }
  const table =
    q.scope === "threads"
      ? q.mode === "substring"
        ? "search_title_trigram"
        : "search_titles"
      : q.mode === "substring"
        ? "search_trigram"
        : "search_prose";
  const where: string[] = [q.scope === "threads" ? "d.kind='thread'" : "1=1"];
  const values: SQLInputValue[] = [];
  if (text) {
    where.push(`${table} MATCH ?`);
    values.push(matchExpression(text, q.mode, q.scope));
  }
  for (const [value, column, operator] of [
    [q.filters.workspaceId, "t.workspace", "="],
    [q.filters.provider, "t.provider", "="],
    [q.filters.status, "t.status", "="],
    [q.filters.agentId, "d.agent", "="],
    [q.filters.kind, "d.kind", "="],
    [q.filters.after, "d.at", ">="],
    [q.filters.before, "d.at", "<="],
  ] as const) {
    if (value !== undefined) {
      where.push(`${column}${operator}?`);
      values.push(value);
    }
  }
  const score = text ? `bm25(${table},8.0,1.0)` : "-d.at";
  const title = text ? `snippet(${table},0,char(1),char(2),'…',24)` : "substr(d.title,1,4096)";
  const body = text && q.scope === "items" ? `snippet(${table},1,char(1),char(2),'…',40)` : "''";
  if (cursor) {
    where.push(
      text ? `(${score}>? OR (${score}=? AND d.id>?))` : "(d.at<? OR (d.at=? AND d.id>?))",
    );
    values.push(
      text ? cursor.score : -cursor.score,
      text ? cursor.score : -cursor.score,
      cursor.id,
    );
  }
  values.push(q.limit + 1);
  const rows = sql
    .get(`SELECT d.id,d.thread,d.item,d.agent,d.kind,d.at,t.title AS threadTitle,t.workspace,t.provider,t.status,
      ${score} AS score,${title} AS titleSnippet,${body} AS bodySnippet
    FROM ${text ? `${table} JOIN search_docs d ON d.id=${table}.rowid` : "search_docs d"}
    JOIN search_threads t ON t.id=d.thread WHERE ${where.join(" AND ")}
    ORDER BY ${text ? "score,d.id" : "d.at DESC,d.id"} LIMIT ?`)
    .all(...values)
    .map((row) => Row.parse(row));
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return SearchResults.parse({
    generation,
    // Each bounded result is a new wire value, not a copy of its database row.
    // oxlint-disable-next-line oxc/no-map-spread
    hits: page.map((row) => ({
      threadId: row.thread,
      threadTitle: row.threadTitle.slice(0, 1024),
      ...(row.item ? { itemId: row.item } : {}),
      ...(row.agent ? { agentId: row.agent } : {}),
      workspaceId: row.workspace,
      provider: row.provider,
      status: row.status,
      kind: row.kind,
      createdAt: row.at,
      score: row.score,
      title: snippet(row.titleSnippet),
      snippet: snippet(row.bodySnippet),
    })),
    cursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({ generation, fingerprint, score: last.score, id: last.id }),
          ).toString("base64url")
        : null,
  });
}
