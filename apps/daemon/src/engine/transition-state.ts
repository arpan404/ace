import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { NativeSessionId } from "@ace/protocol";
import { z } from "zod";
import { HandoffAccess } from "../handoff-access.ts";
import type { Store } from "../store.ts";
import { ExecutionSelection, ExecutionOptions, PortableHandoff, ThreadId } from "@ace/protocol";

export const NativeFork = z.object({
  nativeSessionId: NativeSessionId,
  point: z.object({ type: z.enum(["turn", "item", "end"]), nativeId: z.string().min(1).max(256) }),
});
const Metadata = z.object({
  selection: ExecutionSelection.optional(),
  fork: NativeFork.optional(),
  handoff: PortableHandoff.optional(),
  context: z.array(z.string().max(65536)).max(8).default([]),
});
export type TransitionMetadata = z.infer<typeof Metadata>;
export function admitTransitionMetadata(input: unknown): TransitionMetadata {
  const metadata = Metadata.parse(input);
  if (Buffer.byteLength(JSON.stringify(metadata)) > 131072)
    throw new Error("Transition context capacity exceeded");
  return metadata;
}
/** Durable bounded metadata, read only at command/turn boundaries. */
export class TransitionState {
  private store: Store;
  readonly history: HandoffAccess;
  constructor(store: Store) {
    this.store = store;
    this.history = new HandoffAccess(store);
    store.atomic((_db) =>
      _db.exec(`
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
    this.store.atomic((_db) =>
      this.store
        .statement(
          "DELETE FROM engine_transition_guards WHERE command_id NOT IN (SELECT command_id FROM intents WHERE status IN ('pending','queued','running'))",
        )
        .run(),
    );
  }
  guarded(id: ThreadId): boolean {
    return this.guardOwner(id) !== undefined;
  }
  guardOwner(id: ThreadId): string | undefined {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement("SELECT command_id FROM engine_transition_guards WHERE thread_id=?")
        .get(id);
      return row ? z.string().parse(row.command_id) : undefined;
    });
  }
  guard(id: ThreadId, commandId: string): void {
    this.store.atomic((_db) =>
      this.store.statement("INSERT INTO engine_transition_guards VALUES (?, ?)").run(id, commandId),
    );
  }
  releaseGuards(commandId: string): ThreadId[] {
    return this.store.atomic((_db) => {
      const ids = this.store
        .statement("SELECT thread_id FROM engine_transition_guards WHERE command_id=?")
        .all(commandId)
        .map((row) => ThreadId.parse(row.thread_id));
      this.store
        .statement("DELETE FROM engine_transition_guards WHERE command_id=?")
        .run(commandId);
      return ids;
    });
  }
  get(id: ThreadId): TransitionMetadata {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement("SELECT value FROM engine_transitions WHERE thread_id=?")
        .get(id);
      return Metadata.parse(row ? JSON.parse(String(row.value)) : {});
    });
  }
  set(id: ThreadId, input: TransitionMetadata): void {
    const value = JSON.stringify(admitTransitionMetadata(input));
    this.store.atomic((_db) =>
      this.store
        .statement(`INSERT INTO engine_transitions VALUES (?, ?)
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
    const selectedId = requested.instanceId ?? (same ? previous.instanceId : undefined);
    const instanceId = requested.provider === "cursor" ? cursorInstanceId(selectedId) : selectedId;
    const remembered = this.options(id, requested.provider, model ?? "");
    return ExecutionSelection.parse({
      provider: requested.provider,
      ...(model === undefined ? {} : { model }),
      ...(instanceId ? { instanceId } : {}),
      options:
        requested.options ??
        remembered ??
        (same && model === previous.model ? previous.options : {}),
    });
  }
  admitModel(id: ThreadId, selection: ExecutionSelection): void {
    this.store.atomic((_db) => {
      const count = Number(
        this.store
          .statement("SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?")
          .get(id)?.n,
      );
      if (count >= 32 && !this.options(id, selection.provider, selection.model ?? ""))
        throw new Error("Remembered model capacity exceeded");
    });
  }
  remember(id: ThreadId, selection: ExecutionSelection): void {
    this.store.atomic((_db) => {
      const count = Number(
        this.store
          .statement("SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?")
          .get(id)?.n,
      );
      if (count >= 32 && !this.options(id, selection.provider, selection.model ?? ""))
        throw new Error("Remembered model capacity exceeded");
      // rowid tracks last selection without time/randomness dependencies.
      this.store
        .statement("DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?")
        .run(id, selection.provider, selection.model ?? "");
      this.store
        .statement("INSERT INTO engine_model_options VALUES (?, ?, ?, ?)")
        .run(id, selection.provider, selection.model ?? "", JSON.stringify(selection));
    });
  }
  private latest(id: ThreadId, provider: string): ExecutionSelection | undefined {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement(
          "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(id, provider);
      return row ? ExecutionSelection.parse(JSON.parse(String(row.value))) : undefined;
    });
  }
  private options(id: ThreadId, provider: string, model: string): ExecutionOptions | undefined {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement(
          "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?",
        )
        .get(id, provider, model);
      return row ? ExecutionSelection.parse(JSON.parse(String(row.value))).options : undefined;
    });
  }
}
