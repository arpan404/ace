import { requireEngineColumns } from "./schema-version.ts";
import { z } from "zod";
import { continueMessage } from "@ace/core";
import { hasNextTurnSelection } from "./input-delivery.ts";
import type { StatementSync } from "node:sqlite";
import {
  Command,
  QueueSnapshot,
  QueuePage,
  QueuedMessage,
  type QueueGet,
  QueueState,
  ThreadId,
  type CommandPayload,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import { wakeFor } from "./snooze-wake.ts";

export const RecoveryRecord = QueueState.extend({
  holdToken: z.number().int().nonnegative(),
  limited: z.boolean(),
  resetAt: z.number().int().nonnegative().nullable(),
  /** `clear` lifts a limit at its reset without sending anything (the manual policy). */
  timerAction: z.enum(["resume", "snooze", "migrate", "clear"]).nullable(),
  continuation: z.string().max(16384).nullable(),
  trigger: z.enum(["restart", "limit_resume"]).nullable(),
  exited: z.boolean(),
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;
export const maxMessages = 256;
/**
 * Whether a hold reads as the provider dying on its own. It only describes a restart hold: any
 * other hold, or none, clears it, and a restart hold set anew (a real restart) clears it unless
 * the thread was already held for that exit, which the restart then found and kept.
 */
function exitedAfter(before: RecoveryRecord, patch: Partial<RecoveryRecord>): boolean {
  const paused = patch.paused ?? before.paused;
  const reason = patch.reason === undefined ? before.reason : patch.reason;
  if (!paused || reason !== "restart") return false;
  if (patch.exited !== undefined) return patch.exited;
  return before.paused && before.reason === "restart" && before.exited;
}
/** Clients see `exited` only when it is true; every other hold reads as before. */
export function exitShown(exited: boolean): { exited?: true } {
  return exited ? { exited: true } : {};
}
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
      db.exec(`CREATE TABLE IF NOT EXISTS engine_queue (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT,
        hold_token INTEGER NOT NULL DEFAULT 0, last_failure TEXT, preferences JSON,
        exited INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS engine_queue_attachments (
        intent_id INTEGER NOT NULL REFERENCES intents(id),thread_id TEXT NOT NULL,hash TEXT NOT NULL,
        PRIMARY KEY(intent_id,hash)
      );
      CREATE INDEX IF NOT EXISTS engine_queue_attachment_lookup ON engine_queue_attachments(thread_id,hash);
      CREATE INDEX IF NOT EXISTS engine_queue_deadline ON engine_queue(resume_at) WHERE resume_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS intents_live_positions ON intents(thread_id,position) WHERE status IN ('pending','queued','running') OR uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_uncertain ON intents(thread_id) WHERE uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_queue_messages_recovery ON intents(thread_id,position,id) WHERE ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1));
      CREATE INDEX IF NOT EXISTS intents_queue_order ON intents(thread_id,position,id) WHERE status IN ('pending','queued');
      INSERT OR IGNORE INTO engine_queue(thread_id) SELECT thread_id FROM thread_state;`);
      requireEngineColumns(db, "engine_queue", ["hold_token", "last_failure", "preferences"]);
      // Forward migration: a hold recorded before this column can't say what stopped it, so it
      // keeps reading as a restart.
      if (
        !db
          .prepare("PRAGMA table_info(engine_queue)")
          .all()
          .some((column) => column.name === "exited")
      )
        db.exec("ALTER TABLE engine_queue ADD COLUMN exited INTEGER NOT NULL DEFAULT 0");
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
  /** Held on input whose send or session start failed; it waits for the person's retry. */
  heldOnFailedSend(id: ThreadId): boolean {
    const row = this.sql("SELECT paused, reason FROM engine_queue WHERE thread_id=?").get(id);
    return row?.paused === 1 && (row.reason === "not_sent" || row.reason === "model_unavailable");
  }
  get(id: ThreadId): RecoveryRecord {
    const row = this.sql("SELECT * FROM engine_queue WHERE thread_id=?").get(id);
    if (!row) throw new Error("Missing queue metadata");
    return RecoveryRecord.parse({
      pendingCount: this.count(id) + (row.continuation && !this.uncertainRecovery(id) ? 1 : 0),
      holdToken: row.hold_token,
      revision: row.revision,
      paused: row.paused === 1,
      reason: row.reason,
      lastFailure: row.last_failure == null ? null : JSON.parse(String(row.last_failure)),
      limited: row.limited === 1,
      resetAt: row.reset_at,
      resumeAt: row.resume_at,
      timerAction: row.timer_action,
      continuation: row.continuation,
      trigger: row.trigger,
      exited: row.exited === 1,
    });
  }
  /** The record as clients see it: a `clear` deadline lifts a limit but promises no resume. */
  shown(id: ThreadId): RecoveryRecord {
    const value = this.get(id);
    return value.timerAction === "clear" ? { ...value, resumeAt: null } : value;
  }
  set(id: ThreadId, patch: Partial<RecoveryRecord>, at: number): void {
    this.store.atomic(() => {
      const before = this.get(id);
      const value = RecoveryRecord.parse({
        ...before,
        ...patch,
        exited: exitedAfter(before, patch),
        ...(patch.paused === false ||
        (patch.reason !== undefined &&
          patch.reason !== "not_sent" &&
          patch.reason !== "model_unavailable")
          ? { lastFailure: null }
          : {}),
      });
      value.revision++;
      this.sql(
        `UPDATE engine_queue SET revision=?,paused=?,reason=?,limited=?,reset_at=?,resume_at=?,timer_action=?,continuation=?,trigger=?,hold_token=?,last_failure=?,exited=? WHERE thread_id=?`,
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
        value.lastFailure ? JSON.stringify(value.lastFailure) : null,
        Number(value.exited),
        id,
      );
      const { exited, ...shown } = value;
      const queue = QueueState.parse({
        ...shown,
        ...exitShown(exited),
        pendingCount: this.count(id) + (value.continuation && !this.uncertainRecovery(id) ? 1 : 0),
      });
      this.store.appendEvents(
        id,
        [...wakeFor(this.store, id, queue, at), { type: "queue.updated", ...queue }],
        at,
      );
    });
  }
  count(id: ThreadId): number {
    // Daemon-owned child results are pending ace input, not the person's queue:
    // they never appear in the Queued strip, so they never count toward it.
    return Number(
      this.sql(
        "SELECT COUNT(*) AS n FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1))",
      ).get(id)?.n,
    );
  }
  private uncertainRecovery(id: ThreadId): boolean {
    return Boolean(
      this.sql(
        "SELECT 1 FROM intents WHERE thread_id=? AND kind IN ('thread.resume','queue.resume','thread.limit') AND uncertain=1 LIMIT 1",
      ).get(id),
    );
  }
  private message(payload: unknown, uncertain: unknown) {
    const command = Command.parse(JSON.parse(String(payload)));
    const p = command.payload;
    if (p.type !== "thread.send" && p.type !== "thread.create") {
      if (
        uncertain !== 1 ||
        !("threadId" in p) ||
        !["thread.resume", "queue.resume", "thread.limit"].includes(p.type)
      )
        throw new Error("Invalid queue entry");
      return QueuedMessage.parse({
        id: command.id,
        input: [{ type: "text", text: continueMessage }],
        delivery: "queue",
        state: "uncertain",
      });
    }
    return QueuedMessage.parse({
      id: command.id,
      input: p.input,
      requiresNextTurn: hasNextTurnSelection(p) || undefined,
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
    // A thread the engine never queued for (a development thread) has nothing waiting; reading
    // it must not fail the read it is part of, such as an agent's thread_read.
    if (!this.sql("SELECT 1 FROM engine_queue WHERE thread_id=?").get(id))
      return QueueSnapshot.parse({
        threadId: id,
        pendingCount: 0,
        revision: 0,
        paused: false,
        reason: null,
        resumeAt: null,
        messages: [],
      });
    const rows = this.sql(
      "SELECT payload,uncertain FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1)) ORDER BY position,id LIMIT 256",
    ).all(id);
    const { exited, ...shown } = this.shown(id);
    return QueueSnapshot.parse({
      ...shown,
      ...exitShown(exited),
      threadId: id,
      messages: rows.map((row) => this.message(row.payload, row.uncertain)),
    });
  }
  page(request: Pick<QueueGet, "threadId" | "after" | "expectedRevision" | "limit">): QueuePage {
    const limit = request.limit ?? 16;
    const queue = this.shown(request.threadId);
    if (request.expectedRevision !== undefined && request.expectedRevision !== queue.revision)
      throw new Error("queue_conflict");
    if (request.after && request.expectedRevision === undefined)
      throw new Error("queue_revision_required");
    const cursor = request.after
      ? this.sql(
          "SELECT position,id FROM intents WHERE thread_id=? AND command_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND (status IN ('pending','queued') OR uncertain=1)",
        ).get(request.threadId, request.after)
      : undefined;
    if (request.after && !cursor) throw new Error("invalid_queue_cursor");
    const rows = this.sql(
      "SELECT payload,uncertain FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1)) AND (position>? OR (position=? AND id>?)) ORDER BY position,id LIMIT ?",
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
    const { exited, ...shown } = queue;
    return QueuePage.parse({
      ...shown,
      ...exitShown(exited),
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
    // Daemon-owned child results are never editable: the person's Queued strip
    // only offers Edit/Steer/Remove for their own messages.
    const row = this.sql(
      "SELECT id,payload,uncertain FROM intents WHERE thread_id=? AND command_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1))",
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
    // Person reordering only spans their own messages; daemon-owned child
    // results stay ordered by the delegation service (position 0, before all).
    const rows = this.sql(
      "SELECT id FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND kind IN ('thread.send','thread.create') AND status IN ('pending','queued') ORDER BY position,id LIMIT 256",
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
    this.set(
      id,
      value.reason === "uncertain" && !this.hasUncertain(id)
        ? {
            reason: value.limited
              ? "limit"
              : value.continuation
                ? value.trigger === "limit_resume"
                  ? "limit"
                  : "restart"
                : "manual",
            paused: true,
          }
        : {},
      at,
    );
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
  /** Threads a usage limit holds, for an account reading that may let them go. */
  limited(): ThreadId[] {
    return this.sql(
      "SELECT thread_id FROM engine_queue WHERE limited=1 AND paused=1 AND reason='limit' LIMIT 256",
    )
      .all()
      .map((row) => QueueSnapshot.shape.threadId.parse(row.thread_id));
  }
  due(now: number): ThreadId[] {
    return this.sql(
      "SELECT thread_id FROM engine_queue WHERE resume_at<=? ORDER BY resume_at LIMIT 64",
    )
      .all(now)
      .map((row) => QueueSnapshot.shape.threadId.parse(row.thread_id));
  }
}
