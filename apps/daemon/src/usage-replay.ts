import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { UsageEvent } from "@ace/usage";

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
const payload = `CASE type
  WHEN 'thread.created' THEN json_object('type',type,'workspace',COALESCE(${text(field("thread.workspaceId"))},''),'provider',${text(field("thread.provider"))})
  WHEN 'agent.created' THEN json_object('type',type,'id',${text(field("agent.id"))},'parent',${text(field("agent.parentId"))},'model',${text(field("agent.model"))},'provider',${text(field("agent.native.provider"))})
  WHEN 'agent.updated' THEN ${agentUpdate}
  WHEN 'run.started' THEN json_object('type',type,'agent',${text(field("run.agentId"))},'run',COALESCE(${text(field("run.id"))},'omitted-run:'||seq))
  WHEN 'usage.updated' THEN ${usage} END`;
const eventEntry = `json_object('seq',seq,'at',at,'threadId',${text("thread_id")},'payload',json(${payload}))`;
const deletionEntry = `json_object('seq',seq,'at',at,'threadId',${text("thread_id")},'payload',json_object('type','thread.deleted'))`;
const types = "('thread.created','agent.created','agent.updated','run.started','usage.updated')";
const entries = `WITH entries AS (
  SELECT seq, ${eventEntry} AS entry FROM events WHERE seq>? AND seq<=? AND type IN ${types}
  UNION ALL
  SELECT seq, ${deletionEntry} FROM usage_deletions WHERE seq>? AND seq<=?
)`;

/** Count compact bytes in SQLite before materializing any event in Node. */
export class UsageReplay {
  private readonly sizes;
  private readonly entry;
  constructor(db: DatabaseSync) {
    this.sizes = db.prepare(
      `${entries} SELECT seq, length(CAST(entry AS BLOB)) AS bytes FROM entries ORDER BY seq`,
    );
    this.entry =
      db.prepare(`SELECT ${eventEntry} AS entry FROM events WHERE seq=? AND type IN ${types}
      UNION ALL SELECT ${deletionEntry} FROM usage_deletions WHERE seq=?`);
  }
  read(input: unknown, headSeq: number): { throughSeq: number; events: UsageEvent[] } {
    const q = Options.parse(input);
    const end = Math.min(headSeq, q.afterSeq + q.limit);
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
