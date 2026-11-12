import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { turnCarryingOrigins } from "@ace/projection/turn-boundary";
import { UsageEvent, maxSkills } from "@ace/usage";

const Options = z.object({
  afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(256),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024)
    .default(512 * 1024),
});
const Row = z.object({ seq: z.number().int().positive(), bytes: z.number().int().nonnegative() });
const PageEnd = z.number().int().nonnegative();
// SQLite extracts only analytics fields. Large title/cwd/native data never crosses into Node.
const field = (path: string) => `json_extract(payload, '$.${path}')`;
const text = (expression: string) =>
  `CASE WHEN length(CAST(${expression} AS BLOB))<=8192 THEN ${expression} ELSE NULL END`;
const optional = (base: string, key: string, path: string) =>
  `json_set(${base}, CASE WHEN json_type(payload, '$.${path}') IS NULL THEN '$._unused' ELSE '$.${key}' END, ${text(field(path))})`;
const agentUpdate = optional(
  optional(
    optional(`json_object('type',type,'id',${text(field("agentId"))})`, "parent", "parentId"),
    "model",
    "model",
  ),
  "provider",
  "native.provider",
);
const usageFields = [
  "usageScope",
  "cachedInputTokens",
  "reasoningTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "costUsd",
  "model",
  "accountId",
  "billingMode",
  "counterMode",
  "counterKey",
];
let usage = `json_object('type',type,'agentId',${text(field("agentId"))},'inputTokens',${field("inputTokens")},'outputTokens',${field("outputTokens")})`;
for (const key of usageFields) usage = optional(usage, key, key);
const present = (path: string) => `COALESCE(json_type(payload, '$.${path}'),'null')<>'null'`;
const delegation = (base: string) =>
  `(${["delegatedBy", "delegatedFrom", "startedBy"].map((key) => present(`${base}${key}`)).join(" OR ")})`;
// A root ask (ADR 0062's turn rule), the same messages compactEvent's `turn.asked` keeps.
const asks = `${field("item.type")}='message' AND ${field("item.role")}='user'
  AND COALESCE(${field("item.synthetic")},0)=0 AND json_type(payload,'$.item.inherited') IS NULL
  AND COALESCE(${field("item.origin.kind")},'') NOT IN (${turnCarryingOrigins.map((kind) => `'${kind}'`).join(",")})`;
const skills = `(SELECT json_group_array(name) FROM (
  SELECT DISTINCT json_extract(part.value,'$.name') AS name FROM json_each(payload,'$.item.parts') AS part
  WHERE json_extract(part.value,'$.type')='mention' AND json_extract(part.value,'$.kind')='skill'
    AND json_type(part.value,'$.name')='text' AND length(CAST(json_extract(part.value,'$.name') AS BLOB)) BETWEEN 1 AND 8192
  LIMIT ${maxSkills}))`;
const automation = `${field("item.origin.kind")}='automation' AND json_type(payload,'$.item.origin.role')='text'
  AND length(CAST(${field("item.origin.role")} AS BLOB)) BETWEEN 1 AND 8192`;
const asked = `json_set(json_object('type','turn.asked','agent',${text(field("item.agentId"))},'skills',json(${skills})),
  CASE WHEN ${automation} THEN '$.automation' ELSE '$._unused' END, ${field("item.origin.role")})`;
const payload = `CASE type
  WHEN 'thread.created' THEN json_object('type',type,'workspace',COALESCE(${text(field("thread.workspaceId"))},''),'provider',${text(field("thread.provider"))},'delegated',json(CASE WHEN ${delegation("thread.")} THEN 'true' ELSE 'false' END))
  WHEN 'thread.updated' THEN json_object('type','thread.delegated')
  WHEN 'item.created' THEN ${asked}
  WHEN 'agent.created' THEN json_object('type',type,'id',${text(field("agent.id"))},'parent',${text(field("agent.parentId"))},'model',${text(field("agent.model"))},'provider',${text(field("agent.native.provider"))})
  WHEN 'agent.updated' THEN ${agentUpdate}
  WHEN 'run.started' THEN json_object('type',type,'agent',${text(field("run.agentId"))},'run',COALESCE(${text(field("run.id"))},'omitted-run:'||seq))
  WHEN 'usage.updated' THEN ${usage} END`;
const eventEntry = `json_object('seq',seq,'at',at,'threadId',${text("thread_id")},'payload',json(${payload}))`;
const deletionEntry = `json_object('seq',seq,'at',at,'threadId',${text("thread_id")},'payload',json_object('type','thread.deleted'))`;
const types = "('thread.created','agent.created','agent.updated','run.started','usage.updated')";
// Item and thread updates are many; only asks and delegation links cross into the projection.
const relevant = `(type IN ${types} OR (type='thread.updated' AND ${delegation("")}) OR (type='item.created' AND ${asks}))`;
const entries = `WITH entries AS (
  SELECT seq, ${eventEntry} AS entry FROM events WHERE seq>? AND seq<=? AND ${relevant}
  UNION ALL
  SELECT seq, ${deletionEntry} FROM usage_deletions WHERE seq>? AND seq<=?
)`;

/** Count compact bytes in SQLite before materializing any event in Node. */
export class UsageReplay {
  private readonly sizes;
  private readonly pageEnd;
  private readonly entry;
  constructor(db: DatabaseSync) {
    this.pageEnd = db.prepare(`SELECT seq FROM (
      SELECT seq FROM events WHERE seq>? AND seq<=?
      UNION ALL SELECT seq FROM usage_deletions WHERE seq>? AND seq<=?
    ) ORDER BY seq LIMIT 1 OFFSET ?`);
    this.sizes = db.prepare(
      `${entries} SELECT seq, length(CAST(entry AS BLOB)) AS bytes FROM entries ORDER BY seq`,
    );
    this.entry = db.prepare(`SELECT ${eventEntry} AS entry FROM events WHERE seq=? AND ${relevant}
      UNION ALL SELECT ${deletionEntry} FROM usage_deletions WHERE seq=?`);
  }
  read(input: unknown, headSeq: number): { throughSeq: number; events: UsageEvent[] } {
    const q = Options.parse(input);
    const boundary = this.pageEnd.get(q.afterSeq, headSeq, q.afterSeq, headSeq, q.limit - 1);
    const end = PageEnd.parse(boundary?.seq ?? headSeq);
    const events: UsageEvent[] = [];
    let bytes = 2;
    let throughSeq = end;
    const params = [q.afterSeq, end, q.afterSeq, end];
    for (const raw of this.sizes.iterate(...params)) {
      const row = Row.parse(raw);
      // Even incompatible historical records have bounded, cursor-bearing omission markers.
      let event: UsageEvent;
      let size = row.bytes;
      if (size <= Math.min(64 * 1024, q.maxBytes - 3)) {
        if (bytes + size + 1 > q.maxBytes) {
          throughSeq = row.seq - 1;
          break;
        }
        const value = this.entry.get(row.seq, row.seq)?.entry;
        const parsed = UsageEvent.safeParse(JSON.parse(String(value)));
        if (parsed.success) event = parsed.data;
        else event = this.omitted(row.seq);
      } else event = this.omitted(row.seq);
      // Unknown projection fields are removed by the compact schema.
      size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size + 1 > q.maxBytes) {
        throughSeq = row.seq - 1;
        break;
      }
      events.push(event);
      bytes += size + 1;
    }
    return { throughSeq, events };
  }
  private omitted(seq: number): UsageEvent {
    return { seq, at: 0, threadId: "omitted", payload: { type: "usage.skipped" } };
  }
}
