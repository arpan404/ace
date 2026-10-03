import { createHash } from "node:crypto";
import { z } from "zod";
import { ThreadId, ItemId, ThreadSearchRequest, ThreadSearchResponse } from "@ace/protocol";
import type { Statements } from "./writer.ts";
import { matchExpression } from "./text.ts";
import { snippet } from "./query.ts";

export interface ThreadSearchContext {
  /** Only already-authorized, nondeleted descendants. Caller resolves the family. */
  threadIds?: readonly string[];
  headSeq: number;
  turnOrdinalForItem?: (threadId: ThreadId, itemId: ItemId) => number | null;
}
const Cursor = z.object({
  fingerprint: z.string().length(64),
  id: z.number().int().positive(),
  ceiling: z.number().int().nonnegative(),
  anchor: z.string().min(1).max(514),
});
const Row = z.object({
  id: z.number(),
  thread: ThreadId,
  item: ItemId,
  seq: z.number(),
  marked: z.string(),
});
const Meta = z.object({ seq: z.number(), pending: z.number() });
const Max = z.object({ ceiling: z.number() });
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** Chronological keyset search stops after a bounded page, without ranking all matches. */
export function queryThreadSearch(
  sql: Statements,
  input: unknown,
  context: ThreadSearchContext,
): ThreadSearchResponse {
  const parsed = ThreadSearchRequest.safeParse(input);
  if (!parsed.success) throw new Error("search_invalid_query");
  const q = parsed.data;
  const threadIds =
    q.scope === "tree" ? [...new Set(context.threadIds ?? [q.threadId])].toSorted() : [q.threadId];
  if (threadIds.length > 1024 || !threadIds.includes(q.threadId))
    throw new Error("search_invalid_query");
  for (const id of threadIds) ThreadId.parse(id);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ text: q.text.trim(), filter: q.filter, scope: q.scope, threadIds }))
    .digest("hex");
  const terms = matchExpression(q.text.trim(), "tokens", "items").split(" AND ");
  let cursor: z.infer<typeof Cursor> | undefined;
  if (q.cursor) {
    try {
      cursor = Cursor.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
    } catch {
      throw new Error("search_invalid_query");
    }
    if (cursor.fingerprint !== fingerprint) throw new Error("search_invalid_query");
  }
  if (cursor && !terms.includes(cursor.anchor)) throw new Error("search_invalid_query");
  const scopeExpression = ` AND thread : (${threadIds.map(quote).join(" OR ")})${q.filter ? ` AND category : ${quote(q.filter)}` : ""}`;
  const highlightExpression = `body : (${terms.join(" OR ")})`;
  // Count at most 64 postings per term. Rare anchors avoid broad OR candidates,
  // while a common term never requires a history-sized document-frequency scan.
  let anchor = cursor?.anchor ?? terms[0] ?? "";
  if (!cursor && terms.length > 1) {
    let smallest = 65;
    for (const term of terms) {
      const frequency = sql
        .get(
          "SELECT rowid FROM search_full_fts WHERE search_full_fts MATCH ? ORDER BY rowid LIMIT 64",
        )
        .all(`body : (${term})`).length;
      if (frequency <= smallest) {
        anchor = term;
        smallest = frequency;
      }
    }
  }
  const expression = `body : (${anchor})${scopeExpression}`;
  const requiredTerms = terms.filter((term) => term !== anchor).map((term) => `body : (${term})`);
  const termConstraints = requiredTerms
    .map(
      () => `AND EXISTS(
    SELECT 1 FROM search_full_chunks term_chunk CROSS JOIN search_full_fts
    WHERE term_chunk.thread=c.thread AND term_chunk.item=c.item AND search_full_fts.rowid=term_chunk.id AND term_chunk.id<=? ${q.filter ? "AND term_chunk.category=?" : ""} AND search_full_fts MATCH ?)`,
    )
    .join(" ");
  // New rows never reorder an active traversal. A fresh search sees later chunks.
  const ceiling =
    cursor?.ceiling ??
    Max.parse(sql.get("SELECT COALESCE(MAX(id),0) AS ceiling FROM search_full_chunks").get())
      .ceiling;
  // The FTS thread field prunes candidates. Exact columns own scope isolation.
  const scopeFilter = `AND c.thread IN (${threadIds.map(() => "?").join(",")})${q.filter ? " AND c.category=?" : ""}`;
  const scopeValues = q.filter ? [...threadIds, q.filter] : threadIds;
  const boundedTermValues = requiredTerms.flatMap((term) =>
    q.filter ? [ceiling, q.filter, term] : [ceiling, term],
  );
  const rows = sql
    .get(`WITH selected AS MATERIALIZED (SELECT c.id
    FROM search_full_fts JOIN search_full_chunks c ON c.id=search_full_fts.rowid
    WHERE search_full_fts MATCH ? AND search_full_fts.rowid>? AND search_full_fts.rowid<=?
      AND NOT EXISTS(SELECT 1 FROM search_tombstones t WHERE t.thread=c.thread)
      AND NOT EXISTS(
        SELECT 1 FROM search_full_chunks earlier CROSS JOIN search_full_fts
        WHERE earlier.thread=c.thread AND earlier.item=c.item AND search_full_fts.rowid=earlier.id AND earlier.id<c.id ${q.filter ? "AND earlier.category=c.category" : ""} AND search_full_fts MATCH ?)
    ${scopeFilter}
    ${termConstraints}
    ORDER BY search_full_fts.rowid LIMIT ?)
    SELECT c.id,c.thread,c.item,c.seq,snippet(search_full_fts,0,char(1),char(2),'…',40) AS marked
    FROM selected s CROSS JOIN search_full_chunks c CROSS JOIN search_full_fts
    WHERE c.id=s.id AND search_full_fts.rowid=s.id AND search_full_fts MATCH ? ORDER BY c.id`)
    .all(
      expression,
      cursor?.id ?? 0,
      ceiling,
      `body : (${anchor})`,
      ...scopeValues,
      ...boundedTermValues,
      q.limit + 1,
      highlightExpression,
    )
    .map((row) => Row.parse(row));
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const meta = Meta.parse(sql.get("SELECT seq,pending FROM search_full_meta WHERE id=1").get());
  return ThreadSearchResponse.parse({
    type: "thread.search",
    requestId: q.requestId,
    threadId: q.threadId,
    hits: page.map((row) => ({
      threadId: row.thread,
      itemId: row.item,
      seq: row.seq,
      turnOrdinal: context.turnOrdinalForItem?.(row.thread, row.item) ?? null,
      snippet: snippet(row.marked),
    })),
    cursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify({ fingerprint, id: last.id, ceiling, anchor })).toString(
            "base64url",
          )
        : null,
    indexedSeq: meta.seq,
    headSeq: context.headSeq,
    pending: meta.pending,
    ready: meta.seq === context.headSeq && meta.pending === 0,
  });
}
