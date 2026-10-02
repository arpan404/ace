import { apply, type Fact, type ThreadState, type IdSource } from "@ace/core";
import { randomUUID } from "node:crypto";
import { Command, ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { decodeSnapshot } from "./snapshot.ts";
import { migrateEngine } from "./migrations.ts";

export interface Intent {
  id: number;
  threadId: ThreadId;
  command: Command;
  status: string;
  attempts: number;
}
export class EngineRepository {
  readonly store: Store;
  private ids: IdSource;
  constructor(store: Store, ids: IdSource = { next: () => randomUUID() }) {
    this.ids = ids;
    this.store = store;
    store.atomic(migrateEngine);
  }
  state(id: ThreadId): ThreadState | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT state FROM thread_state WHERE thread_id = ?").get(id);
      return row ? decodeSnapshot(String(row.state)) : undefined;
    });
  }
  requireState(id: ThreadId): ThreadState {
    const state = this.state(id);
    if (!state) throw new Error("Missing engine state");
    return state;
  }
  states(): ThreadState[] {
    return this.store.atomic((db) =>
      db
        .prepare("SELECT state FROM thread_state")
        .all()
        .map((row) => decodeSnapshot(String(row.state))),
    );
  }
  save(state: ThreadState, payloads: EventPayload[], at: number): void {
    this.store.atomic((db) => {
      this.store.appendEvents(state.threadId, payloads, at);
      db.prepare(`INSERT INTO thread_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state, seq=excluded.seq`).run(
        state.threadId,
        JSON.stringify(state),
        this.store.headSeq(),
      );
    });
  }
  apply(id: ThreadId, facts: Fact[], now: number): ThreadState {
    const state = this.state(id);
    if (!state) throw new Error("Missing engine state");
    const events = facts.flatMap((input) => {
      let fact = input;
      if (fact.type === "interaction.closed" && fact.state === "resolved") {
        const interaction = Object.hasOwn(state.interactions, fact.interaction)
          ? state.interactions[fact.interaction]
          : undefined;
        const answer = interaction ? this.answer(interaction.id) : undefined;
        if (answer?.payload.type === "interaction.resolve")
          fact = { ...fact, resolution: answer.payload.resolution, resolvedBy: answer.deviceId };
      }
      return apply(state, fact, { now, ids: this.ids });
    });
    this.save(state, events, now);
    return state;
  }
  add(command: Command, id: ThreadId, resolutionId?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(`INSERT INTO intents
      (command_id, thread_id, kind, payload, status, resolution_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(command.id, id, command.payload.type, JSON.stringify(command), resolutionId ?? null),
    );
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
                "SELECT * FROM intents WHERE status IN ('pending', 'queued', 'running') ORDER BY id",
              )
              .all()
          : db
              .prepare(
                "SELECT * FROM intents WHERE thread_id = ? AND status IN ('pending', 'queued', 'running') ORDER BY id",
              )
              .all(id);
      return rows.map((row) => ({
        id: Number(row.id),
        threadId: ThreadId.parse(row.thread_id),
        command: Command.parse(JSON.parse(String(row.payload))),
        status: String(row.status),
        attempts: Number(row.attempts),
      }));
    });
  }
  queuedCount(id: ThreadId): number {
    return this.store.atomic((db) =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM intents WHERE thread_id = ? AND status = 'queued'",
          )
          .get(id)?.count,
      ),
    );
  }
  mark(intent: Intent, status: string, error?: string): void {
    this.store.atomic((db) =>
      db
        .prepare(`UPDATE intents SET status = ?, error = ?,
      attempts = attempts + ? WHERE id = ?`)
        .run(status, error ?? null, status === "running" ? 1 : 0, intent.id),
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
