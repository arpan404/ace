import { z } from "zod";
import { HandoffAccess } from "../handoff-access.ts";
import type { Store } from "../store.ts";
import {
  ExecutionSelection,
  ExecutionOptions,
  PortableHandoff,
  type ThreadId,
} from "@ace/protocol";

export const NativeFork = z.object({
  nativeSessionId: z.string().min(1).max(256),
  point: z.object({ type: z.enum(["turn", "item", "end"]), nativeId: z.string().min(1).max(256) }),
});
const Metadata = z.object({
  selection: ExecutionSelection.optional(),
  fork: NativeFork.optional(),
  handoff: PortableHandoff.optional(),
  context: z.array(z.string().max(65536)).max(8).default([]),
});
export type TransitionMetadata = z.infer<typeof Metadata>;
/** Durable bounded metadata, read only at command/turn boundaries. */
export class TransitionState {
  private store: Store;
  readonly history: HandoffAccess;
  constructor(store: Store) {
    this.store = store;
    this.history = new HandoffAccess(store);
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS engine_transitions (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, value JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engine_transition_guards (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, command_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engine_model_options (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, model TEXT NOT NULL, value JSON NOT NULL,
        PRIMARY KEY(thread_id,provider,model)
      );`),
    );
  }
  pruneGuards(): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "DELETE FROM engine_transition_guards WHERE command_id NOT IN (SELECT command_id FROM intents WHERE status IN ('pending','queued','running'))",
        )
        .run(),
    );
  }
  guarded(id: ThreadId): boolean {
    return this.store.atomic((db) =>
      Boolean(
        db.prepare("SELECT thread_id FROM engine_transition_guards WHERE thread_id=?").get(id),
      ),
    );
  }
  guard(id: ThreadId, commandId: string): void {
    this.store.atomic((db) =>
      db.prepare("INSERT INTO engine_transition_guards VALUES (?, ?)").run(id, commandId),
    );
  }
  releaseGuards(commandId: string): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM engine_transition_guards WHERE command_id=?").run(commandId),
    );
  }
  get(id: ThreadId): TransitionMetadata {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT value FROM engine_transitions WHERE thread_id=?").get(id);
      return Metadata.parse(row ? JSON.parse(String(row.value)) : {});
    });
  }
  set(id: ThreadId, input: TransitionMetadata): void {
    const value = JSON.stringify(Metadata.parse(input));
    if (Buffer.byteLength(value) > 131072) throw new Error("Transition context capacity exceeded");
    this.store.atomic((db) =>
      db
        .prepare(`INSERT INTO engine_transitions VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value`)
        .run(id, value),
    );
  }
  selection(
    id: ThreadId,
    fallback: ExecutionSelection,
    requested: {
      provider: ExecutionSelection["provider"];
      model?: string | undefined;
      instanceId?: string | undefined;
      options?: ExecutionOptions | undefined;
    },
  ): ExecutionSelection {
    const previous = this.get(id).selection ?? fallback;
    const same = previous.provider === requested.provider;
    const model =
      requested.model ?? (same ? previous.model : this.latest(id, requested.provider)?.model);
    const remembered = this.options(id, requested.provider, model ?? "");
    return ExecutionSelection.parse({
      provider: requested.provider,
      ...(model === undefined ? {} : { model }),
      ...(requested.instanceId
        ? { instanceId: requested.instanceId }
        : same && previous.instanceId
          ? { instanceId: previous.instanceId }
          : {}),
      options:
        requested.options ??
        remembered ??
        (same && model === previous.model ? previous.options : {}),
    });
  }
  admitModel(id: ThreadId, selection: ExecutionSelection): void {
    this.store.atomic((db) => {
      const count = Number(
        db.prepare("SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?").get(id)?.n,
      );
      if (count >= 32 && !this.options(id, selection.provider, selection.model ?? ""))
        throw new Error("Remembered model capacity exceeded");
    });
  }
  remember(id: ThreadId, selection: ExecutionSelection): void {
    this.store.atomic((db) => {
      const count = Number(
        db.prepare("SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?").get(id)?.n,
      );
      if (count >= 32 && !this.options(id, selection.provider, selection.model ?? ""))
        throw new Error("Remembered model capacity exceeded");
      // rowid tracks last selection without time/randomness dependencies.
      db.prepare(
        "DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?",
      ).run(id, selection.provider, selection.model ?? "");
      db.prepare("INSERT INTO engine_model_options VALUES (?, ?, ?, ?)").run(
        id,
        selection.provider,
        selection.model ?? "",
        JSON.stringify(selection),
      );
    });
  }
  private latest(id: ThreadId, provider: string): ExecutionSelection | undefined {
    return this.store.atomic((db) => {
      const row = db
        .prepare(
          "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(id, provider);
      return row ? ExecutionSelection.parse(JSON.parse(String(row.value))) : undefined;
    });
  }
  private options(id: ThreadId, provider: string, model: string): ExecutionOptions | undefined {
    return this.store.atomic((db) => {
      const row = db
        .prepare(
          "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?",
        )
        .get(id, provider, model);
      return row ? ExecutionSelection.parse(JSON.parse(String(row.value))).options : undefined;
    });
  }
}
