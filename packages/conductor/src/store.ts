import { DatabaseSync } from "node:sqlite";
import { retainReceipt } from "./receipt-policy.ts";
import { Effect, Fact, Key, State, type Environment, type Transition } from "./schema.ts";
import { Count, Payload, StoredRoot, freezeState } from "./persistence-schema.ts";
import { StatePersistence } from "./persistence.ts";
import { reduce, start } from "./reducer.ts";

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
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conductor_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, inputs INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS conductor_inputs (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(run,id));
      CREATE TABLE IF NOT EXISTS conductor_outbox (ordinal INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conductor_outbox_run ON conductor_outbox(run,ordinal);
      CREATE TRIGGER IF NOT EXISTS conductor_inputs_count AFTER INSERT ON conductor_inputs BEGIN UPDATE conductor_runs SET inputs=inputs+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_add AFTER INSERT ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_remove AFTER DELETE ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending-1 WHERE id=OLD.run; END;`);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.sql = statements(this.db);
    this.persistence = new StatePersistence(this.db);
  }
  close(): void {
    this.actors.clear();
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
  pending(id: string): Effect[] {
    Key.parse(id);
    return this.sql.pending
      .all(id)
      .map((row) => Effect.parse(JSON.parse(Payload.parse(row).payload)));
  }
  /** Check an already decoded intent against concurrent command pruning. */
  hasPending(id: string, effectId: string): boolean {
    Key.parse(id);
    Key.parse(effectId);
    return this.sql.effect.get(id, effectId) !== undefined;
  }
  create(id: string, spec: unknown, env: Environment): State {
    const existing = this.load(id);
    if (existing) return existing;
    this.room(id);
    const next = this.atomic(() => {
      const transition = start(id, spec, env);
      // Parent row exists before content-addressed artifact FK inserts.
      this.sql.writeRun.run(id, "{}");
      this.write(transition, null, MAX_PENDING);
      return transition.state;
    });
    return this.admit(next);
  }
  apply(id: string, receipt: string, fact: unknown, env: Environment): State {
    Key.parse(receipt);
    const state = this.required(id);
    const next = this.atomic(() => {
      if (this.sql.receipt.get(id, receipt)) return state;
      const parsed = Fact.parse(fact);
      const retain = retainReceipt(state, parsed, Count.parse(this.sql.countInputs.get(id)).n);
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
      if (retain) this.sql.insertReceipt.run(id, receipt);
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
  private room(id: string): void {
    if (!this.actors.has(id) && this.actors.size >= MAX_ACTORS)
      throw new Error("actor_backpressure");
  }
  private admit(state: State): State {
    this.room(state.id);
    const frozen = freezeState(state);
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
