import { apply, type Fact, type ThreadState, type IdSource } from "@ace/core";
import type { StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Command, CommandId, ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { decodeSnapshot } from "./snapshot.ts";
import { capFact, readRawBlob } from "./raw.ts";
import { QueueStore } from "./queue-store.ts";
import { Snapshot } from "./persistence.ts";
import { migrateEngine } from "./migrations.ts";

import { IntentStore, type IntentHeader } from "./intents.ts";
export type { Intent, IntentHeader } from "./intents.ts";
export class EngineRepository {
  readonly store: Store;
  readonly queue: QueueStore;
  readonly pending: IntentStore;
  observe?: (state: ThreadState, facts: Fact[], events: EventPayload[], at: number) => void;
  private ids: IdSource;
  private capacity: number;
  private commandId: () => string;
  private opening = new Set<ThreadId>();
  private snapshots = new Map<ThreadId, Snapshot>();
  private admissionStatements: {
    has: StatementSync;
    mark: StatementSync;
    ack: StatementSync;
    correlated: StatementSync;
  };
  constructor(
    store: Store,
    ids: IdSource = { next: () => randomUUID() },
    capacity = 64,
    commandId: () => string = randomUUID,
  ) {
    this.capacity = capacity;
    this.commandId = commandId;
    this.ids = ids;
    this.store = store;
    store.atomic(migrateEngine);
    this.queue = new QueueStore(store);
    this.pending = new IntentStore(store, this.queue);
    store.atomic((db) => db.exec("DELETE FROM engine_slots"));
    this.admissionStatements = store.atomic((db) => ({
      has: db.prepare(
        "SELECT 1 FROM engine_state_records WHERE thread_id=? AND section='engineAdmission' AND key='root'",
      ),
      mark: db.prepare(
        "INSERT OR IGNORE INTO engine_state_records VALUES (?, 'engineAdmission', 'root', 'true')",
      ),
      correlated: db.prepare(
        `UPDATE intents SET awaiting=0, acknowledged=1 WHERE thread_id=? AND command_id=? AND awaiting=1 RETURNING id`,
      ),
      ack: db.prepare(`UPDATE intents SET awaiting=0, acknowledged=1 WHERE thread_id=? AND awaiting=1 AND ack_target=(
        SELECT ack_target FROM intents WHERE thread_id=? AND awaiting=1 ORDER BY id LIMIT 1
      ) RETURNING id`),
    }));
  }
  nextCommandId() {
    return CommandId.parse(this.commandId());
  }
  beginSessionOpen(id: ThreadId): void {
    this.opening.add(id);
  }
  finishSessionOpen(id: ThreadId): void {
    this.opening.delete(id);
  }
  private recoveryAcknowledgement(id: ThreadId): boolean {
    return !this.opening.has(id) && this.pending.recoveryAcknowledgement(id);
  }
  state(id: ThreadId): ThreadState | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT state FROM thread_state WHERE thread_id = ?").get(id);
      if (!row) {
        this.snapshots.delete(id);
        return undefined;
      }
      let snapshot = this.snapshots.get(id);
      if (!snapshot) snapshot = new Snapshot(db, decodeSnapshot(String(row.state)));
      this.snapshots.delete(id);
      this.snapshots.set(id, snapshot);
      this.trim();
      return snapshot.state;
    });
  }
  evict(id: ThreadId): void {
    this.snapshots.delete(id);
  }
  requireState(id: ThreadId): ThreadState {
    const state = this.state(id);
    if (!state) throw new Error("Missing engine state");
    return state;
  }
  *states(): Iterable<ThreadState> {
    const ids = this.store.atomic((db) =>
      db
        .prepare("SELECT thread_id FROM thread_state")
        .all()
        .map((row) => ThreadId.parse(row.thread_id)),
    );
    for (const id of ids) yield this.requireState(id);
  }
  save(state: ThreadState, payloads: EventPayload[], at: number): void {
    this.store.atomic((db) => {
      let snapshot = this.snapshots.get(state.threadId);
      if (!snapshot || snapshot.state !== state) snapshot = new Snapshot(db, state);
      snapshot.retainChanges(payloads);
      this.store.appendEvents(state.threadId, payloads, at);
      db.prepare(`INSERT INTO thread_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state, seq=excluded.seq`).run(
        state.threadId,
        snapshot.header(),
        this.store.headSeq(),
      );
      snapshot.flush();
      this.snapshots.set(state.threadId, snapshot);
      this.trim();
    });
  }
  private trim(): void {
    if (this.snapshots.size > this.capacity) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
  }
  apply(id: ThreadId, facts: Fact[], now: number): ThreadState {
    try {
      return this.store.atomic(() => {
        const state = this.state(id);
        if (!state) throw new Error("Missing engine state");
        this.snapshots.get(id)?.begin();
        let continuationStarted = false;
        const events = facts.flatMap((input) => {
          const queue = input.type === "turn.started" ? this.queue.get(id) : undefined;
          if (
            input.type === "turn.started" &&
            input.agent === (state.rootKey ?? "root") &&
            queue?.trigger &&
            this.recoveryAcknowledgement(id)
          )
            input = { ...input, trigger: queue.trigger };
          let fact = capFact((raw) => this.store.capRaw(raw, id), input);
          if (fact.type === "interaction.closed" && fact.state === "resolved") {
            const interaction = Object.hasOwn(state.interactions, fact.interaction)
              ? state.interactions[fact.interaction]
              : undefined;
            const answer = interaction ? this.answer(interaction.id) : undefined;
            if (answer?.payload.type === "interaction.resolve")
              fact = {
                ...fact,
                resolution: answer.payload.resolution,
                resolvedBy: answer.deviceId,
              };
          }
          const snapshot = this.snapshots.get(id);
          const finish = snapshot?.prepare(fact) ?? (() => {});
          try {
            const emitted = apply(state, fact, { now, ids: this.ids });
            if (
              fact.type === "turn.started" &&
              (fact.trigger === "restart" || fact.trigger === "limit_resume") &&
              emitted.some((event) => event.type === "run.started")
            )
              continuationStarted = true;
            if (fact.type === "item.delta" && emitted.some((event) => event.type === "item.delta"))
              snapshot?.delta(fact);
            snapshot?.remember(fact, emitted);
            return emitted;
          } finally {
            finish();
          }
        });
        // Admission-based providers transfer queue ownership before a run starts.
        // Persist the acknowledgement policy in the existing per-thread record store,
        // so a later run cannot acknowledge the next, unrelated engine input.
        const root = state.agents[state.rootKey ?? ""]?.agent.id;
        for (const event of events) {
          const admitted =
            event.type === "input.admitted" && event.agentId === root && !this.opening.has(id);
          if (admitted) this.admissionStatements.mark.run(id);
          const started =
            event.type === "run.started" &&
            !this.opening.has(id) &&
            event.run.agentId === root &&
            ["user", "queue", "unknown", "restart", "limit_resume"].includes(event.run.trigger) &&
            !this.admissionStatements.has.get(id);
          const acknowledged =
            event.type === "input.admitted" && admitted && event.commandId !== undefined
              ? this.admissionStatements.correlated.all(id, event.commandId)
              : admitted || started
                ? this.admissionStatements.ack.all(id, id)
                : [];
          for (const row of acknowledged) this.queue.prune(Number(row.id));
        }
        if (continuationStarted && this.queue.get(id).trigger) {
          this.queue.set(id, { continuation: null, trigger: null }, now);
          this.pending.finishContinuation(id);
        }
        this.save(state, events, now);
        this.observe?.(state, facts, events, now);
        return state;
      });
    } catch (error) {
      this.evict(id);
      throw error;
    }
  }

  add(command: Command, id: ThreadId, resolutionId?: string): void {
    this.pending.add(command, id, resolutionId);
  }
  reserve(id: ThreadId): boolean {
    return this.store.atomic((db) => {
      if (db.prepare("SELECT thread_id FROM engine_slots WHERE thread_id=?").get(id)) return true;
      const count = Number(db.prepare("SELECT COUNT(*) AS count FROM engine_slots").get()?.count);
      if (count >= this.capacity) return false;
      db.prepare("INSERT INTO engine_slots VALUES (?)").run(id);
      return true;
    });
  }
  release(id: ThreadId): void {
    this.store.atomic((db) => db.prepare("DELETE FROM engine_slots WHERE thread_id=?").run(id));
  }
  reservedSlot(id: ThreadId): boolean {
    return this.store.atomic((db) =>
      Boolean(db.prepare("SELECT thread_id FROM engine_slots WHERE thread_id=?").get(id)),
    );
  }
  readRawBlob(id: string): Uint8Array | undefined {
    return this.store.atomic((db) => readRawBlob(db, id));
  }
  answer(id: string): Command | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT payload FROM intents WHERE resolution_id = ?").get(id);
      return row ? Command.parse(JSON.parse(String(row.payload))) : undefined;
    });
  }
  reserved(id: string): boolean {
    return this.store.atomic((db) =>
      Boolean(db.prepare("SELECT id FROM intents WHERE resolution_id = ?").get(id)),
    );
  }
  sessionOpening(id: ThreadId): boolean {
    return this.opening.has(id);
  }
  queuedCount(id: ThreadId): number {
    return this.store.atomic((db) =>
      Number(
        db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM intents WHERE thread_id=? AND (status IN ('pending','queued') OR uncertain=1) AND kind IN ('thread.send','thread.create')) + (SELECT COUNT(DISTINCT ack_target) FROM intents WHERE thread_id=? AND awaiting=1 AND status<>'queued') + (SELECT COUNT(*) FROM engine_queue q WHERE q.thread_id=? AND q.continuation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.thread_id=q.thread_id AND i.kind IN ('thread.resume','queue.resume','thread.limit') AND i.awaiting=1)) AS count",
          )
          .get(id, id, id)?.count,
      ),
    );
  }
  claim(intent: IntentHeader) {
    return this.pending.claim(intent);
  }
  beginSend(intent: IntentHeader, target: number | undefined): void {
    this.pending.beginSend(intent, target);
  }
  mark(intent: IntentHeader, status: string, error?: string): void {
    this.pending.mark(intent, status, error);
  }
  workspace(id: string): string | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(id);
      return row ? String(row.path) : undefined;
    });
  }
  session(id: ThreadId): {
    cwd: string;
    model?: string;
    nativeSessionId?: string;
    instanceId?: string;
  } {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT * FROM engine_sessions WHERE thread_id = ?").get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return {
        cwd: String(row.cwd),
        ...(typeof row.instance_id === "string" ? { instanceId: row.instance_id } : {}),
        ...(row.model === null ? {} : { model: String(row.model) }),
        ...(row.native_session_id === null
          ? {}
          : { nativeSessionId: String(row.native_session_id) }),
      };
    });
  }
  createSession(id: ThreadId, cwd: string, model?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO engine_sessions (thread_id, cwd, model, native_session_id) VALUES (?, ?, ?, NULL)",
        )
        .run(id, cwd, model ?? null),
    );
  }
  nativeSession(id: ThreadId, nativeId: string, instanceId?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE engine_sessions SET native_session_id = ?, instance_id = COALESCE(?, instance_id) WHERE thread_id = ?",
        )
        .run(nativeId, instanceId ?? null, id),
    );
  }
}
