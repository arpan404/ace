import { clientView, clientSummary } from "./client-view.ts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { retainReceipt } from "./receipt-policy.ts";
import {
  Effect,
  Fact,
  Key,
  State,
  type Environment,
  type Transition,
  type Account,
} from "./schema.ts";
import { Count, Payload, StoredRoot, freezeState } from "./persistence-schema.ts";
import { StatePersistence } from "./persistence.ts";
import { reduce, start } from "./reducer.ts";
import { migrateEffects, queueCleanup } from "./effect-storage.ts";
import { cursorPosition, runCursor } from "./pagination.ts";
import { z } from "zod";

const MAX_PENDING = 1024;
const CONTROL_PENDING = 2048;
const CLEANUP_PENDING = 3072;
const MAX_ACTORS = 8;

/** One writer/actor per run. Cached admitted state and changed rows keep control
 * independent of immutable plan size. Cache publishes only after SQLite commit. */
export class ConductorStore {
  private readonly db: DatabaseSync;
  private readonly sql: ReturnType<typeof statements>;
  private readonly persistence: StatePersistence;
  private readonly actors = new Map<string, State>();
  private readonly pinned = new Map<string, number>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conductor_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, inputs INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS conductor_inputs (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(run,id));
      CREATE TABLE IF NOT EXISTS conductor_outbox (ordinal INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conductor_outbox_run ON conductor_outbox(run,ordinal);
      CREATE INDEX IF NOT EXISTS conductor_pending_runs ON conductor_runs(id) WHERE pending>0;
      CREATE INDEX IF NOT EXISTS conductor_active_runs ON conductor_runs(id) WHERE pending>0 OR json_extract(payload,'$.phase') NOT IN ('done','cancelled');
      CREATE TRIGGER IF NOT EXISTS conductor_inputs_count AFTER INSERT ON conductor_inputs BEGIN UPDATE conductor_runs SET inputs=inputs+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_add AFTER INSERT ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_remove AFTER DELETE ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending-1 WHERE id=OLD.run; END;`);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.atomic(() => migrateEffects(this.db));
    this.sql = statements(this.db);
    this.persistence = new StatePersistence(this.db);
  }
  close(): void {
    this.actors.clear();
    this.pinned.clear();
    this.db.close();
  }
  load(id: string): State | null {
    Key.parse(id);
    const admitted = this.actors.get(id);
    if (admitted) return admitted;
    const row = this.sql.load.get(id);
    if (!row) return null;
    this.room(id);
    const input: unknown = JSON.parse(Payload.parse(row).payload);
    const root = StoredRoot.safeParse(input);
    let state: State;
    if (root.success) state = this.persistence.restore(root.data);
    else {
      if (typeof input === "object" && input !== null && Object.hasOwn(input, "storageVersion"))
        throw root.error;
      state = State.parse(input);
      // Upgrade the v1 full snapshot once, retaining receipts/outbox ids.
      this.atomic(() =>
        this.persistence.write(state, null, (metadata) =>
          this.sql.writeRun.run(id, JSON.stringify(metadata)),
        ),
      );
    }
    return this.admit(state);
  }
  /** Paged persisted run ids, without admitting actors or decoding their plans. */
  list(after = "", limit = 16, active = false): { ids: string[]; next?: string } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      throw new Error("invalid_page_limit");
    const activity = "COALESCE(json_extract(payload,'$.updatedAt'),0)";
    const creation = "COALESCE(json_extract(payload,'$.startedAt'),0)";
    const shape = z.object({ id: Key, updatedAt: z.number(), startedAt: z.number() });
    const cursor = after
      ? (cursorPosition(after) ??
        shape.parse(
          this.db
            .prepare(
              `SELECT id,${activity} AS updatedAt,${creation} AS startedAt FROM conductor_runs WHERE id=?`,
            )
            .get(after),
        ))
      : undefined;
    const rows = this.db
      .prepare(`SELECT id,${activity} AS updatedAt,${creation} AS startedAt FROM conductor_runs WHERE
      (?=0 OR json_extract(payload,'$.phase') NOT IN ('done','cancelled'))
      AND (?=0 OR (${activity},${creation}) < (?,?) OR ((${activity},${creation})=(?,?) AND id>?))
      ORDER BY ${activity} DESC,${creation} DESC,id LIMIT ?`)
      .all(
        Number(active),
        Number(!!cursor),
        cursor?.updatedAt ?? 0,
        cursor?.startedAt ?? 0,
        cursor?.updatedAt ?? 0,
        cursor?.startedAt ?? 0,
        cursor?.id ?? "",
        limit + 1,
      )
      .map((row) => shape.parse(row));
    const ids = rows.slice(0, limit).map((row) => row.id);
    const last = rows[limit - 1];
    return { ids, ...(rows.length > limit && last ? { next: runCursor(last) } : {}) };
  }
  /** Restart admission visits indexed nonterminal runs, including empty outboxes. */
  resumable(): string[] {
    return this.db
      .prepare(
        "SELECT id FROM conductor_runs WHERE pending>0 OR json_extract(payload,'$.phase') NOT IN ('done','cancelled') ORDER BY id",
      )
      .all()
      .map((row) => Key.parse(row.id));
  }
  /** Reads do not occupy one of the eight execution slots. */
  read(id: string): State | null {
    Key.parse(id);
    const admitted = this.actors.get(id);
    if (admitted) return admitted;
    const row = this.sql.load.get(id);
    if (!row) return null;
    const input: unknown = JSON.parse(Payload.parse(row).payload);
    const root = StoredRoot.safeParse(input);
    return root.success ? this.persistence.restore(root.data) : State.parse(input);
  }
  summary(id: string) {
    Key.parse(id);
    const row = this.sql.load.get(id);
    if (!row) return null;
    const input: unknown = JSON.parse(Payload.parse(row).payload);
    const root = StoredRoot.safeParse(input);
    return root.success ? this.persistence.summary(root.data) : clientSummary(State.parse(input));
  }
  view(id: string) {
    Key.parse(id);
    const row = this.sql.load.get(id);
    if (!row) return null;
    const input: unknown = JSON.parse(Payload.parse(row).payload);
    const root = StoredRoot.safeParse(input);
    if (root.success) return this.persistence.view(root.data);
    const state = State.parse(input);
    return clientView(
      state,
      Object.values(state.lanes).filter((lane) => lane.live),
      Object.values(state.nodes),
    );
  }
  pending(id: string): Effect[] {
    Key.parse(id);
    return this.sql.pending
      .all(id)
      .map((row) => Effect.parse(JSON.parse(Payload.parse(row).payload)));
  }
  ready(id: string, at: number): Effect[] {
    Key.parse(id);
    return this.sql.ready
      .all(id, at)
      .map((row) => Effect.parse(JSON.parse(Payload.parse(row).payload)));
  }
  defer(id: string, effectId: string, at: number): void {
    this.sql.defer.run(at, id, effectId);
  }
  hasFailures(id: string): boolean {
    return this.sql.failed.get(id) !== undefined;
  }
  /** Awaited executors keep their actors; excess idle reads can use durable state uncached. */
  pin(id: string): () => void {
    this.pinned.set(id, (this.pinned.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.pinned.get(id) ?? 1) - 1;
      if (remaining) this.pinned.set(id, remaining);
      else this.pinned.delete(id);
    };
  }
  /** Check an already decoded intent against concurrent command pruning. */
  hasPending(id: string, effectId: string): boolean {
    Key.parse(id);
    Key.parse(effectId);
    return this.sql.effect.get(id, effectId) !== undefined;
  }
  create(id: string, spec: unknown, env: Environment, accounts?: readonly Account[]): State {
    const existing = this.load(id);
    if (existing) return existing;
    this.room(id);
    const next = this.atomic(() => {
      const initial = start(id, spec, env);
      const admitted = accounts
        ? reduce(initial.state, { type: "accounts", accounts }, env)
        : initial;
      const transition = {
        state: admitted.state,
        effects: accounts ? [...initial.effects, ...admitted.effects] : initial.effects,
      };
      // Parent row exists before content-addressed artifact FK inserts.
      this.sql.writeRun.run(id, "{}");
      this.write(transition, null, MAX_PENDING);
      return transition.state;
    });
    return this.admit(next);
  }
  apply(id: string, receipt: string, fact: unknown, env: Environment): State {
    Key.parse(receipt);
    return this.applyFact(id, receipt, fact, env);
  }
  /** Current observer facts are fenced by lane generation/time, not retained input ids. */
  observe(id: string, input: unknown, env: Environment): State {
    const fact = Fact.parse(input);
    if (!["status", "accounts", "usage_limit", "tick"].includes(fact.type))
      throw new Error("invalid_observation");
    return this.applyFact(id, undefined, fact, env);
  }
  private applyFact(
    id: string,
    receipt: string | undefined,
    fact: unknown,
    env: Environment,
  ): State {
    const state = this.required(id);
    const next = this.atomic(() => {
      if (receipt && this.sql.receipt.get(id, receipt)) return state;
      const parsed = Fact.parse(fact);
      const retain =
        receipt && retainReceipt(state, parsed, Count.parse(this.sql.countInputs.get(id)).n);
      const transition = reduce(state, parsed, env);
      if (transition.state.phase === "cancelling" && state.phase !== "cancelling")
        this.sql.pruneControls.run(id);
      const capacity =
        parsed.type === "cancel" || ["cancelling", "cancelled"].includes(state.phase)
          ? CLEANUP_PENDING
          : ["approve", "pause", "resume"].includes(parsed.type)
            ? CONTROL_PENDING
            : MAX_PENDING;
      this.write(transition, state, capacity);
      if (retain && receipt) this.sql.insertReceipt.run(id, receipt);
      return transition.state;
    });
    return this.admit(next);
  }
  complete(id: string, effectId: string, facts: readonly unknown[], env: Environment): State {
    Key.parse(effectId);
    const previous = this.required(id);
    const next = this.atomic(() => {
      let state = previous;
      if (!this.sql.effect.get(id, effectId)) return state;
      if (facts.length > 64) throw new Error("effect_result_backpressure");
      this.sql.deleteEffect.run(id, effectId);
      const effects: Effect[] = [];
      for (const fact of facts) {
        const transition = reduce(state, fact, env);
        state = transition.state;
        effects.push(...transition.effects);
      }
      this.write(
        { state, effects },
        previous,
        ["cancelling", "cancelled"].includes(state.phase) ? CLEANUP_PENDING : MAX_PENDING,
      );
      return state;
    });
    return this.admit(next);
  }
  abandonIntegration(id: string, effectId: string, env: Environment): State {
    Key.parse(effectId);
    const state = this.required(id);
    const next = this.atomic(() => {
      if (state.phase !== "cancelling") throw new Error("run_not_cancelling");
      this.sql.deleteEffect.run(id, effectId);
      const transition = reduce({ ...state, integration: null }, { type: "tick" }, env);
      this.write(transition, state, CLEANUP_PENDING);
      return transition.state;
    });
    return this.admit(next);
  }
  delete(id: string): void {
    const state = this.required(id);
    if (state.phase !== "done" && state.phase !== "cancelled") throw new Error("run_still_live");
    if (Count.parse(this.sql.countPending.get(id)).n > 0) throw new Error("run_effects_pending");
    this.sql.deleteRun.run(id);
    this.actors.delete(id);
  }
  /** Release a terminal cached actor without deleting its durable report. */
  release(id: string): void {
    const state = this.required(id);
    if (!["done", "cancelled"].includes(state.phase)) throw new Error("run_still_live");
    this.actors.delete(id);
  }
  private room(id: string): boolean {
    if (!this.actors.has(id) && this.actors.size >= MAX_ACTORS) {
      for (const candidate of this.actors.keys()) {
        if (this.pinned.has(candidate)) continue;
        this.actors.delete(candidate);
        return true;
      }
      return false;
    }
    return true;
  }
  private admit(state: State): State {
    const frozen = freezeState(state);
    if (!this.room(state.id)) return frozen;
    this.actors.delete(state.id);
    this.actors.set(state.id, frozen);
    return frozen;
  }
  private required(id: string): State {
    const state = this.load(id);
    if (!state) throw new Error("run_not_found");
    return state;
  }
  private write(transition: Transition, previous: State | null, capacity: number): void {
    const { state, effects } = transition;
    if (
      Object.keys(state.nodes).length > 256 ||
      Object.keys(state.lanes).length > 8192 ||
      Object.keys(state.gates).length > 512
    )
      throw new Error("run_indexes_exceed_capacity");
    const row = this.sql.countPending.get(state.id);
    const count = row ? Count.parse(row).n : 0;
    if (effects.length && count + effects.length > capacity) throw new Error("effect_backpressure");
    this.persistence.write(state, previous, (root) =>
      this.sql.writeRun.run(state.id, JSON.stringify(root)),
    );
    for (const effect of effects)
      this.sql.insertEffect.run(state.id, effect.id, JSON.stringify(Effect.parse(effect)));
    if (["done", "cancelled"].includes(state.phase)) queueCleanup(this.db, state.id);
  }
  private atomic<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
function statements(db: DatabaseSync) {
  return {
    load: db.prepare("SELECT payload FROM conductor_runs WHERE id=?"),
    pending: db.prepare(
      "SELECT payload FROM conductor_outbox WHERE run=? ORDER BY ordinal LIMIT 3072",
    ),
    ready: db.prepare(
      "SELECT payload FROM conductor_outbox WHERE run=? AND retry_at<=? ORDER BY ordinal LIMIT 3072",
    ),
    defer: db.prepare(
      "UPDATE conductor_outbox SET retry_at=?+MIN(30000,1000*(1 << MIN(failures,5))),failures=MIN(30,failures+1) WHERE run=? AND id=?",
    ),
    failed: db.prepare("SELECT id FROM conductor_outbox WHERE run=? AND failures>0 LIMIT 1"),
    receipt: db.prepare("SELECT id FROM conductor_inputs WHERE run=? AND id=?"),
    countInputs: db.prepare("SELECT inputs AS n FROM conductor_runs WHERE id=?"),
    insertReceipt: db.prepare("INSERT INTO conductor_inputs(run,id) VALUES (?,?)"),
    effect: db.prepare("SELECT id FROM conductor_outbox WHERE run=? AND id=?"),
    deleteEffect: db.prepare("DELETE FROM conductor_outbox WHERE run=? AND id=?"),
    deleteRun: db.prepare("DELETE FROM conductor_runs WHERE id=?"),
    countPending: db.prepare("SELECT pending AS n FROM conductor_runs WHERE id=?"),
    writeRun: db.prepare(
      "INSERT INTO conductor_runs(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
    ),
    insertEffect: db.prepare("INSERT INTO conductor_outbox(run,id,payload) VALUES (?,?,?)"),
    pruneControls: db.prepare(
      "DELETE FROM conductor_outbox WHERE run=? AND (json_extract(payload,'$.type')='gate' OR (json_extract(payload,'$.type')='control' AND json_extract(payload,'$.action')!='cancel'))",
    ),
  };
}
