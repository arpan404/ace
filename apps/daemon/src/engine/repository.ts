import { apply, type Fact, type ThreadState, type IdSource } from "@ace/core";
import { randomUUID } from "node:crypto";
import { Command, ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { decodeSnapshot } from "./snapshot.ts";
import { capFact, readRawBlob } from "./raw.ts";
import { Snapshot } from "./persistence.ts";
import { migrateEngine } from "./migrations.ts";

export interface Intent {
  id: number;
  threadId: ThreadId;
  command: Command;
  status: string;
  attempts: number;
  awaiting: boolean;
}
export class EngineRepository {
  readonly store: Store;
  private ids: IdSource;
  private capacity: number;
  private snapshots = new Map<ThreadId, Snapshot>();
  constructor(store: Store, ids: IdSource = { next: () => randomUUID() }, capacity = 64) {
    this.capacity = capacity;
    this.ids = ids;
    this.store = store;
    store.atomic(migrateEngine);
    store.atomic((db) => db.exec("DELETE FROM engine_slots"));
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
        const events = facts.flatMap((input) => {
          let fact = this.store.atomic((db) => capFact(db, input));
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
          const emitted = apply(state, fact, { now, ids: this.ids });
          if (fact.type === "item.delta" && emitted.some((event) => event.type === "item.delta"))
            this.snapshots.get(id)?.delta(fact);
          return emitted;
        });
        for (const event of events)
          if (
            event.type === "run.started" &&
            ["user", "queue", "unknown"].includes(event.run.trigger) &&
            event.run.agentId === state.agents[state.rootKey ?? ""]?.agent.id
          )
            this.store.atomic((db) =>
              db
                .prepare(`UPDATE intents SET awaiting=0 WHERE id=(
          SELECT id FROM intents WHERE thread_id=? AND awaiting=1 ORDER BY id LIMIT 1
        )`)
                .run(id),
            );
        this.save(state, events, now);
        return state;
      });
    } catch (error) {
      this.evict(id);
      throw error;
    }
  }

  add(command: Command, id: ThreadId, resolutionId?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(`INSERT INTO intents
      (command_id, thread_id, kind, payload, status, resolution_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(command.id, id, command.payload.type, JSON.stringify(command), resolutionId ?? null),
    );
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
  intents(id?: ThreadId): Intent[] {
    return this.store.atomic((db) => {
      const rows =
        id === undefined
          ? db
              .prepare(
                "SELECT * FROM intents WHERE status IN ('pending', 'queued', 'running') UNION ALL SELECT * FROM intents WHERE awaiting=1 AND status NOT IN ('pending', 'queued', 'running') ORDER BY id",
              )
              .all()
          : db
              .prepare(
                "SELECT * FROM intents WHERE thread_id=? AND status IN ('pending', 'queued', 'running') UNION ALL SELECT * FROM intents WHERE thread_id=? AND awaiting=1 AND status NOT IN ('pending', 'queued', 'running') ORDER BY id",
              )
              .all(id, id);
      return rows.map((row) => ({
        id: Number(row.id),
        threadId: ThreadId.parse(row.thread_id),
        command: Command.parse(JSON.parse(String(row.payload))),
        status: String(row.status),
        attempts: Number(row.attempts),
        awaiting: Number(row.awaiting) === 1,
      }));
    });
  }
  queuedCount(id: ThreadId): number {
    return this.store.atomic((db) =>
      Number(
        db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM intents WHERE thread_id=? AND status='queued') + (SELECT COUNT(*) FROM intents WHERE thread_id=? AND awaiting=1 AND status<>'queued') AS count",
          )
          .get(id, id)?.count,
      ),
    );
  }
  beginSend(intent: Intent, awaiting: boolean): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE intents SET awaiting=? WHERE id=?").run(awaiting ? 1 : 0, intent.id),
    );
  }
  mark(intent: Intent, status: string, error?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(`UPDATE intents SET status = ?, error = ?, awaiting = CASE WHEN ? = 'failed' THEN 0 ELSE awaiting END,
      attempts = attempts + ? WHERE id = ?`)
        .run(status, error ?? null, status, status === "running" ? 1 : 0, intent.id),
    );
  }
  workspace(id: string): string | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(id);
      return row ? String(row.path) : undefined;
    });
  }
  session(id: ThreadId): { cwd: string; model?: string; nativeSessionId?: string } {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT * FROM engine_sessions WHERE thread_id = ?").get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return {
        cwd: String(row.cwd),
        ...(row.model === null ? {} : { model: String(row.model) }),
        ...(row.native_session_id === null
          ? {}
          : { nativeSessionId: String(row.native_session_id) }),
      };
    });
  }
  createSession(id: ThreadId, cwd: string, model?: string): void {
    this.store.atomic((db) =>
      db.prepare("INSERT INTO engine_sessions VALUES (?, ?, ?, NULL)").run(id, cwd, model ?? null),
    );
  }
  nativeSession(id: ThreadId, nativeId: string): void {
    this.store.atomic((db) =>
      db
        .prepare("UPDATE engine_sessions SET native_session_id = ? WHERE thread_id = ?")
        .run(nativeId, id),
    );
  }
}
