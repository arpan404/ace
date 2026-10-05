import { z } from "zod";
import type { StatementSync } from "node:sqlite";
import { Command, CommandId, ThreadId, RunTrigger, InteractionId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { QueueStore } from "./queue-store.ts";

const Header = z.object({
  id: z.number().int().positive(),
  threadId: ThreadId,
  commandId: CommandId,
  kind: z.string(),
  status: z.enum(["pending", "queued", "running", "done", "failed"]),
  attempts: z.number().int().nonnegative(),
  awaiting: z.boolean(),
  ackTarget: z.number().int().positive().optional(),
  delivery: z.enum(["queue", "steer"]),
  acknowledged: z.boolean(),
  resolutionId: InteractionId.optional(),
  resolutionGeneration: z.number().int().nonnegative().optional(),
  submittedGeneration: z.number().int().nonnegative().optional(),
  trigger: RunTrigger.optional(),
});
export type IntentHeader = z.infer<typeof Header>;
export interface Intent extends IntentHeader {
  command: Command;
}
const columns =
  "id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id";
const recoveryKinds = "'thread.resume','queue.resume','thread.limit'";
const deliveryKinds = "'thread.create','thread.send','thread.fork','thread.switch','thread.merge'";
function header(row: Record<string, unknown>): IntentHeader {
  return Header.parse({
    id: row.id,
    threadId: row.thread_id,
    commandId: row.command_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    awaiting: row.awaiting === 1,
    ackTarget: row.ack_target ?? undefined,
    delivery: row.delivery,
    acknowledged: row.acknowledged === 1,
    trigger: row.trigger ?? undefined,
    submittedGeneration: row.submitted_generation ?? undefined,
    resolutionGeneration: row.resolution_generation ?? undefined,
    resolutionId: row.resolution_id ?? undefined,
  });
}
/** Intent I/O: indexed headers for scheduling, payload decoding only at claim/startup. */
export class IntentStore {
  private store: Store;
  private queue: QueueStore;
  private statements = new Map<string, StatementSync>();
  constructor(store: Store, queue: QueueStore) {
    this.store = store;
    this.queue = queue;
    store.atomic((db) => {
      const fields = db.prepare("PRAGMA table_info(intents)").all();
      if (!fields.some((field) => field.name === "acknowledged")) {
        db.exec("ALTER TABLE intents ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0");
      }
      if (!fields.some((field) => field.name === "delivery")) {
        db.exec("ALTER TABLE intents ADD COLUMN delivery TEXT NOT NULL DEFAULT 'queue'");
        db.exec(
          "UPDATE intents SET delivery=COALESCE(json_extract(payload,'$.payload.delivery'),'queue')",
        );
      }
      if (!fields.some((field) => field.name === "trigger")) {
        db.exec("ALTER TABLE intents ADD COLUMN trigger TEXT");
        db.exec(
          "UPDATE intents SET trigger=json_extract(payload,'$.payload.trigger') WHERE kind IN ('thread.create','thread.send')",
        );
      }
      if (!fields.some((field) => field.name === "submitted_generation")) {
        db.exec("ALTER TABLE intents ADD COLUMN submitted_generation INTEGER");
        // Previously claimed input has unknown consumption. Never silently replay it.
        db.exec("UPDATE intents SET submitted_generation=0 WHERE status='running' OR awaiting=1");
      }
      if (!fields.some((field) => field.name === "resolution_generation"))
        db.exec("ALTER TABLE intents ADD COLUMN resolution_generation INTEGER");
      db.exec(`CREATE INDEX IF NOT EXISTS intents_submission_generation ON intents(thread_id,submitted_generation);
        CREATE INDEX IF NOT EXISTS intents_dispatch ON intents(thread_id,kind,position,id) WHERE status IN ('pending','queued');
        CREATE INDEX IF NOT EXISTS intents_running ON intents(thread_id) WHERE status='running';`);
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
  add(command: Command, id: ThreadId, resolutionId?: string, generation?: number): void {
    this.store.atomic(() => {
      const p = command.payload;
      const row = this.sql(`INSERT INTO intents
        (command_id,thread_id,kind,payload,status,resolution_id,position,delivery,trigger,resolution_generation) VALUES (?,?,?,?,'pending',?,?,?,?,?)`).run(
        command.id,
        id,
        p.type,
        JSON.stringify(command),
        resolutionId ?? null,
        this.queue.position(id),
        p.type === "thread.send" ? (p.delivery ?? "queue") : "queue",
        p.type === "thread.send" || p.type === "thread.create" ? (p.trigger ?? null) : null,
        generation ?? null,
      );
      this.queue.track(Number(row.lastInsertRowid), id, command);
    });
  }
  latestGeneration(id: ThreadId): number {
    return z
      .number()
      .int()
      .nonnegative()
      .parse(
        this.sql(
          "SELECT COALESCE(MAX(submitted_generation),0) AS generation FROM intents WHERE thread_id=?",
        ).get(id)?.generation,
      );
  }
  commandStatus(commandId: CommandId) {
    const row = this.sql("SELECT status FROM intents WHERE command_id=? LIMIT 1").get(commandId);
    return row ? Header.shape.status.parse(row.status) : undefined;
  }
  *headers(id?: ThreadId): Iterable<IntentHeader> {
    let after = 0;
    for (;;) {
      const rows =
        id === undefined
          ? this.sql(
              `SELECT ${columns} FROM intents WHERE id>? AND (status IN ('pending','queued','running') OR awaiting=1) ORDER BY id LIMIT 64`,
            ).all(after)
          : this.sql(
              `SELECT ${columns} FROM intents WHERE thread_id=? AND id>? AND (status IN ('pending','queued','running') OR awaiting=1) ORDER BY id LIMIT 64`,
            ).all(id, after);
      if (!rows.length) return;
      for (const row of rows) {
        const value = header(row);
        after = value.id;
        yield value;
      }
    }
  }
  recoveryAcknowledgement(id: ThreadId): boolean {
    return Boolean(
      this.sql(
        "SELECT 1 FROM intents i JOIN engine_state_records r ON r.thread_id=i.thread_id AND r.section='engineRecovery' AND r.key='root' AND i.id=CAST(r.value AS INTEGER) WHERE i.thread_id=? AND (i.acknowledged=1 OR (i.awaiting=1 AND i.status<>'failed')) LIMIT 1",
      ).get(id),
    );
  }
  finishContinuation(id: ThreadId): void {
    this.sql(
      "DELETE FROM engine_state_records WHERE thread_id=? AND section='engineRecovery' AND key='root'",
    ).run(id);
  }
  recovering(id: ThreadId): boolean {
    return (
      this.recoveryAcknowledgement(id) ||
      Boolean(
        this.sql(
          `SELECT 1 FROM intents WHERE thread_id=? AND kind IN (${recoveryKinds}) AND status IN ('pending','running') LIMIT 1`,
        ).get(id),
      )
    );
  }
  recovery(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind IN (${recoveryKinds}) AND status IN ('pending','queued') ORDER BY position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  message(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind IN (${deliveryKinds}) AND status IN ('pending','queued') ORDER BY position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  queuedMessage(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind IN (${deliveryKinds}) AND delivery='queue' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  childResult(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind='thread.send' AND trigger='subagent_result' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  steerMessage(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind='thread.send' AND delivery='steer' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  transition(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind IN ('thread.switch','thread.merge') AND status IN ('pending','queued') ORDER BY CASE kind WHEN 'thread.switch' THEN 0 ELSE 1 END,position,id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  runnableThreads(limit: number): ThreadId[] {
    return this.sql(`SELECT DISTINCT i.thread_id FROM intents i JOIN engine_queue q ON q.thread_id=i.thread_id
      WHERE i.status IN ('pending','queued') AND (i.kind IN (${recoveryKinds},'thread.switch','thread.merge') OR (q.paused=0 AND q.limited=0))
      AND NOT EXISTS(SELECT 1 FROM engine_transition_guards g WHERE g.thread_id=i.thread_id AND g.command_id<>i.command_id)
      AND NOT EXISTS(SELECT 1 FROM engine_slots s WHERE s.thread_id=i.thread_id) LIMIT ?`)
      .all(limit)
      .map((row) => ThreadId.parse(row.thread_id));
  }
  controls(id: ThreadId): IntentHeader[] {
    return this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND kind NOT IN (${deliveryKinds},${recoveryKinds}) AND status='pending' ORDER BY position,id LIMIT 64`,
    )
      .all(id)
      .map(header);
  }
  awaiting(id: ThreadId): IntentHeader | undefined {
    const row = this.sql(
      `SELECT ${columns} FROM intents WHERE thread_id=? AND awaiting=1 ORDER BY id LIMIT 1`,
    ).get(id);
    return row ? header(row) : undefined;
  }
  running(id: ThreadId): boolean {
    return Boolean(
      this.sql("SELECT 1 FROM intents WHERE thread_id=? AND status='running' LIMIT 1").get(id),
    );
  }
  resolvingInteractions(id: ThreadId): ReadonlySet<InteractionId> {
    return new Set(
      this.sql(
        "SELECT resolution_id FROM intents WHERE thread_id=? AND status='running' AND kind='interaction.resolve' AND resolution_id IS NOT NULL",
      )
        .all(id)
        .map((row) => InteractionId.parse(row.resolution_id)),
    );
  }
  acknowledged(id: number): boolean {
    return this.sql("SELECT acknowledged FROM intents WHERE id=?").get(id)?.acknowledged === 1;
  }
  claim(entry: IntentHeader): Intent | undefined {
    return this.store.atomic(() => {
      const row = this.sql(
        `SELECT ${columns},payload FROM intents WHERE id=? AND status IN ('pending','queued')`,
      ).get(entry.id);
      if (!row) return undefined;
      const intent = { ...header(row), command: Command.parse(JSON.parse(String(row.payload))) };
      this.mark(intent, "running");
      return intent;
    });
  }
  beginSend(intent: IntentHeader, target: number | undefined): void {
    if (
      target !== undefined &&
      ["thread.resume", "queue.resume", "thread.limit"].includes(intent.kind)
    )
      this.sql(
        "INSERT INTO engine_state_records VALUES (?, 'engineRecovery', 'root', ?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value",
      ).run(intent.threadId, String(intent.id));
    this.sql("UPDATE intents SET awaiting=?, ack_target=? WHERE id=?").run(
      target === undefined ? 0 : 1,
      target ?? null,
      intent.id,
    );
  }
  submit(intent: IntentHeader, generation: number): void {
    this.sql("UPDATE intents SET submitted_generation=? WHERE id=? AND status='running'").run(
      generation,
      intent.id,
    );
  }
  submitted(id: number): number | undefined {
    const row = this.sql("SELECT submitted_generation FROM intents WHERE id=?").get(id);
    return row?.submitted_generation == null
      ? undefined
      : z.number().int().nonnegative().parse(row.submitted_generation);
  }
  defer(intent: IntentHeader): void {
    this.sql(
      "UPDATE intents SET status='queued',awaiting=0,ack_target=NULL,submitted_generation=NULL,uncertain=0 WHERE id=?",
    ).run(intent.id);
  }
  mark(intent: IntentHeader, status: string, error?: string): void {
    this.store.atomic(() => {
      this.sql(`UPDATE intents SET status=?,error=?,awaiting=CASE WHEN ?='failed' THEN 0 ELSE awaiting END,
        attempts=attempts+? WHERE id=?`).run(
        status,
        error ?? null,
        status,
        status === "running" ? 1 : 0,
        intent.id,
      );
      if (status === "done" || status === "failed") this.queue.prune(intent.id);
    });
  }
}
