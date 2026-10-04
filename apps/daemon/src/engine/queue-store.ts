import { z } from "zod";
import type { StatementSync } from "node:sqlite";
import {
  Command,
  QueueSnapshot,
  QueuePage,
  QueuedMessage,
  type QueueGet,
  QueueState,
  type ThreadId,
  type CommandPayload,
} from "@ace/protocol";
import type { Store } from "../store.ts";

export const RecoveryRecord = QueueState.extend({
  holdToken: z.number().int().nonnegative(),
  limited: z.boolean(),
  resetAt: z.number().int().nonnegative().nullable(),
  timerAction: z.enum(["resume", "snooze", "migrate"]).nullable(),
  continuation: z.string().max(16384).nullable(),
  trigger: z.enum(["restart", "limit_resume"]).nullable(),
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;
export const maxMessages = 256;
export const maxMessageBytes = 256 * 1024;
export function isSend(payload: CommandPayload): boolean {
  return payload.type === "thread.send" || payload.type === "thread.create";
}
/** Indexed durable queue metadata, sharing the engine/receipt transaction. */
export class QueueStore {
  private store: Store;
  private statements = new Map<string, StatementSync>();
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) => {
      const columns = db.prepare("PRAGMA table_info(intents)").all();
      if (!columns.some((column) => column.name === "position")) {
        db.exec(
          "ALTER TABLE intents ADD COLUMN position INTEGER NOT NULL DEFAULT 0; UPDATE intents SET position=id",
        );
        db.exec("ALTER TABLE intents ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`CREATE TABLE IF NOT EXISTS engine_queue (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_queue_attachments (
        intent_id INTEGER NOT NULL REFERENCES intents(id),thread_id TEXT NOT NULL,hash TEXT NOT NULL,
        PRIMARY KEY(intent_id,hash)
      );
      CREATE INDEX IF NOT EXISTS engine_queue_attachment_lookup ON engine_queue_attachments(thread_id,hash);
      CREATE INDEX IF NOT EXISTS engine_queue_deadline ON engine_queue(resume_at) WHERE resume_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS intents_live_positions ON intents(thread_id,position) WHERE status IN ('pending','queued','running') OR uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_uncertain ON intents(thread_id) WHERE uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_queue_messages ON intents(thread_id,position,id) WHERE kind IN ('thread.send','thread.create') AND (status IN ('pending','queued') OR uncertain=1);
      CREATE INDEX IF NOT EXISTS intents_queue_order ON intents(thread_id,position,id) WHERE status IN ('pending','queued');
      INSERT OR IGNORE INTO engine_queue(thread_id) SELECT thread_id FROM thread_state;`);
      const queueColumns = db.prepare("PRAGMA table_info(engine_queue)").all();
      if (!queueColumns.some((column) => column.name === "hold_token"))
        db.exec("ALTER TABLE engine_queue ADD COLUMN hold_token INTEGER NOT NULL DEFAULT 0");
      for (const row of db
        .prepare(
          "SELECT id,thread_id,payload FROM intents WHERE kind IN ('thread.create','thread.send') AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1)",
        )
        .iterate()) {
        const command = Command.parse(JSON.parse(String(row.payload)));
        this.track(Number(row.id), QueueSnapshot.shape.threadId.parse(row.thread_id), command);
      }
    });
  }
  private sql(source: string): StatementSync {
    let statement = this.statements.get(source);
    if (!statement) {
      statement = this.store.atomic((db) => db.prepare(source));
      this.statements.set(source, statement);
    }
    return statement;
  }
  ensure(id: ThreadId): void {
    this.sql("INSERT OR IGNORE INTO engine_queue(thread_id) VALUES (?)").run(id);
  }
  get(id: ThreadId): RecoveryRecord {
    const row = this.sql("SELECT * FROM engine_queue WHERE thread_id=?").get(id);
    if (!row) throw new Error("Missing queue metadata");
    return RecoveryRecord.parse({
      holdToken: row.hold_token,
      revision: row.revision,
      paused: row.paused === 1,
      reason: row.reason,
      limited: row.limited === 1,
      resetAt: row.reset_at,
      resumeAt: row.resume_at,
      timerAction: row.timer_action,
      continuation: row.continuation,
      trigger: row.trigger,
    });
  }
  set(id: ThreadId, patch: Partial<RecoveryRecord>, at: number): void {
    this.store.atomic(() => {
      const value = RecoveryRecord.parse({ ...this.get(id), ...patch });
      value.revision++;
      this.sql(
        `UPDATE engine_queue SET revision=?,paused=?,reason=?,limited=?,reset_at=?,resume_at=?,timer_action=?,continuation=?,trigger=?,hold_token=? WHERE thread_id=?`,
      ).run(
        value.revision,
        Number(value.paused),
        value.reason,
        Number(value.limited),
        value.resetAt,
        value.resumeAt,
        value.timerAction,
        value.continuation,
        value.trigger,
        value.holdToken,
        id,
      );
      this.store.appendEvents(id, [{ type: "queue.updated", ...QueueState.parse(value) }], at);
    });
  }
  count(id: ThreadId): number {
    return Number(
      this.sql(
        "SELECT COUNT(*) AS n FROM intents WHERE thread_id=? AND kind IN ('thread.send','thread.create') AND (status IN ('pending','queued') OR uncertain=1)",
      ).get(id)?.n,
    );
  }
  private message(payload: unknown, uncertain: unknown) {
    const command = Command.parse(JSON.parse(String(payload)));
    const p = command.payload;
    if (p.type !== "thread.send" && p.type !== "thread.create")
      throw new Error("Invalid queue entry");
    return QueuedMessage.parse({
      id: command.id,
      input: p.input,
      context: p.context,
      delivery: p.type === "thread.send" ? (p.delivery ?? "queue") : "queue",
      state: uncertain === 1 ? "uncertain" : "queued",
    });
  }
  hasUncertain(id: ThreadId): boolean {
    return Boolean(
      this.sql("SELECT 1 FROM intents WHERE thread_id=? AND uncertain=1 LIMIT 1").get(id),
    );
  }
  snapshot(id: ThreadId): QueueSnapshot {
    const rows = this.sql(
      "SELECT payload,uncertain FROM intents WHERE thread_id=? AND kind IN ('thread.send','thread.create') AND (status IN ('pending','queued') OR uncertain=1) ORDER BY position,id LIMIT 256",
    ).all(id);
    return QueueSnapshot.parse({
      ...this.get(id),
      threadId: id,
      messages: rows.map((row) => this.message(row.payload, row.uncertain)),
    });
  }
  page(request: Pick<QueueGet, "threadId" | "after" | "expectedRevision" | "limit">): QueuePage {
    const limit = request.limit ?? 16;
    const queue = this.get(request.threadId);
    if (request.expectedRevision !== undefined && request.expectedRevision !== queue.revision)
      throw new Error("queue_conflict");
    if (request.after && request.expectedRevision === undefined)
      throw new Error("queue_revision_required");
    const cursor = request.after
      ? this.sql(
          "SELECT position,id FROM intents WHERE thread_id=? AND command_id=? AND (status IN ('pending','queued') OR uncertain=1)",
        ).get(request.threadId, request.after)
      : undefined;
    if (request.after && !cursor) throw new Error("invalid_queue_cursor");
    const rows = this.sql(
      "SELECT payload,uncertain FROM intents WHERE thread_id=? AND kind IN ('thread.send','thread.create') AND (status IN ('pending','queued') OR uncertain=1) AND (position>? OR (position=? AND id>?)) ORDER BY position,id LIMIT ?",
    ).all(
      request.threadId,
      cursor?.position ?? -1,
      cursor?.position ?? -1,
      cursor?.id ?? -1,
      limit + 1,
    );
    const messages: QueuePage["messages"] = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(String(row.payload));
      if (messages.length >= limit || (messages.length && bytes + size > 512 * 1024)) break;
      bytes += size;
      messages.push(this.message(row.payload, row.uncertain));
    }
    return QueuePage.parse({
      ...queue,
      threadId: request.threadId,
      messages,
      total: this.count(request.threadId),
      next: rows.length > messages.length ? (messages.at(-1)?.id ?? null) : null,
    });
  }
  position(id: ThreadId): number {
    return Number(
      this.sql(
        "SELECT COALESCE(MAX(position),0)+1 AS n FROM intents WHERE thread_id=? AND (status IN ('pending','queued','running') OR uncertain=1)",
      ).get(id)?.n,
    );
  }
  editable(
    id: ThreadId,
    message: string,
  ): { id: number; command: Command; uncertain: boolean } | undefined {
    const row = this.sql(
      "SELECT id,payload,uncertain FROM intents WHERE thread_id=? AND command_id=? AND kind IN ('thread.send','thread.create') AND (status IN ('pending','queued') OR uncertain=1)",
    ).get(id, message);
    return row
      ? {
          id: Number(row.id),
          command: Command.parse(JSON.parse(String(row.payload))),
          uncertain: row.uncertain === 1,
        }
      : undefined;
  }
  retains(id: ThreadId, hash: string): boolean {
    return Boolean(
      this.sql(
        "SELECT 1 FROM engine_queue_attachments a JOIN intents i ON i.id=a.intent_id WHERE a.thread_id=? AND a.hash=? AND (i.status IN ('pending','queued','running') OR i.awaiting=1 OR i.uncertain=1) LIMIT 1",
      ).get(id, hash),
    );
  }
  track(intent: number, thread: ThreadId, command: Command): void {
    this.sql("DELETE FROM engine_queue_attachments WHERE intent_id=?").run(intent);
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.send") return;
    for (const hash of new Set(p.context?.attachments.map((attachment) => attachment.sha256) ?? []))
      this.sql("INSERT INTO engine_queue_attachments VALUES (?,?,?)").run(intent, thread, hash);
  }
  prune(intent: number): void {
    this.sql(
      "DELETE FROM engine_queue_attachments WHERE intent_id=? AND EXISTS(SELECT 1 FROM intents WHERE id=? AND status IN ('done','failed') AND awaiting=0 AND uncertain=0)",
    ).run(intent, intent);
  }
  edit(id: number, command: Command): void {
    this.sql("UPDATE intents SET payload=?,delivery=? WHERE id=?").run(
      JSON.stringify(command),
      command.payload.type === "thread.send" ? (command.payload.delivery ?? "queue") : "queue",
      id,
    );
    const thread = this.sql("SELECT thread_id FROM intents WHERE id=?").get(id)?.thread_id;
    this.track(id, QueueSnapshot.shape.threadId.parse(thread), command);
  }
  remove(id: number): void {
    this.sql("DELETE FROM engine_queue_attachments WHERE intent_id=?").run(id);
    this.sql(
      "UPDATE intents SET status='failed',uncertain=0,awaiting=0,error='Removed from queue' WHERE id=?",
    ).run(id);
  }
  move(id: ThreadId, message: number, after: number | null): boolean {
    const rows = this.sql(
      "SELECT id FROM intents WHERE thread_id=? AND kind IN ('thread.send','thread.create') AND status IN ('pending','queued') ORDER BY position,id LIMIT 256",
    )
      .all(id)
      .map((row) => Number(row.id));
    if (!rows.includes(message) || message === after || (after !== null && !rows.includes(after)))
      return false;
    const ordered = rows.filter((key) => key !== message);
    ordered.splice(after === null ? 0 : ordered.indexOf(after) + 1, 0, message);
    const update = this.sql("UPDATE intents SET position=? WHERE id=?");
    ordered.forEach((key, index) => update.run(index + 1, key));
    return true;
  }
  /** Removing one ambiguity must not release independent manual/limit/restart holds. */
  reconcileUncertainty(id: ThreadId, at: number): void {
    const value = this.get(id);
    this.set(id, value.reason === "uncertain" && !this.hasUncertain(id)
      ? { reason: value.limited ? "limit" : value.continuation ? (value.trigger === "limit_resume" ? "limit" : "restart") : "manual", paused: true }
      : {}, at);
  }
  clearUncertain(id: number): void {
    this.sql("UPDATE intents SET uncertain=0 WHERE id=?").run(id);
  }
  uncertain(id: number): void {
    this.sql("UPDATE intents SET uncertain=1 WHERE id=?").run(id);
  }
  nextDeadline(): number | undefined {
    const row = this.sql(
      "SELECT resume_at FROM engine_queue WHERE resume_at IS NOT NULL ORDER BY resume_at LIMIT 1",
    ).get();
    return row ? z.number().int().nonnegative().parse(row.resume_at) : undefined;
  }
  due(now: number): ThreadId[] {
    return this.sql(
      "SELECT thread_id FROM engine_queue WHERE resume_at<=? ORDER BY resume_at LIMIT 64",
    )
      .all(now)
      .map((row) => QueueSnapshot.shape.threadId.parse(row.thread_id));
  }
}
