import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Effect, Key, State, type Environment, type Transition } from "./schema.ts";
import { reduce, start } from "./reducer.ts";

const Payload = z.object({ payload: z.string() });
const Count = z.object({ n: z.number() });
const MAX_RECEIPTS = 65_536;
const MAX_PENDING = 1024;

/** Synchronous SQLite boundary. Caller owns one driver per run and run retention. */
export class ConductorStore {
  private readonly db: DatabaseSync;
  private readonly sql: ReturnType<typeof statements>;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conductor_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, inputs INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS conductor_inputs (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(run,id));
      CREATE TABLE IF NOT EXISTS conductor_outbox (ordinal INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conductor_outbox_run ON conductor_outbox(run,ordinal);
      CREATE TRIGGER IF NOT EXISTS conductor_inputs_count AFTER INSERT ON conductor_inputs BEGIN UPDATE conductor_runs SET inputs=inputs+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_add AFTER INSERT ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending+1 WHERE id=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS conductor_pending_remove AFTER DELETE ON conductor_outbox BEGIN UPDATE conductor_runs SET pending=pending-1 WHERE id=OLD.run; END;
      PRAGMA foreign_keys=ON;`);
    this.sql = statements(this.db);
  }
  close(): void {
    this.db.close();
  }
  load(id: string): State | null {
    Key.parse(id);
    const row = this.sql.load.get(id);
    return row ? State.parse(JSON.parse(Payload.parse(row).payload)) : null;
  }
  pending(id: string): Effect[] {
    return this.sql.pending
      .all(id)
      .map((row) => Effect.parse(JSON.parse(Payload.parse(row).payload)));
  }
  create(id: string, spec: unknown, env: Environment): State {
    return this.atomic(() => {
      const existing = this.load(id);
      if (existing) return existing;
      const transition = start(id, spec, env);
      this.write(transition);
      return transition.state;
    });
  }
  apply(id: string, receipt: string, fact: unknown, env: Environment): State {
    Key.parse(receipt);
    return this.atomic(() => {
      const state = this.required(id);
      if (this.sql.receipt.get(id, receipt)) return state;
      const count = Count.parse(this.sql.countInputs.get(id)).n;
      if (count >= MAX_RECEIPTS) throw new Error("input_backpressure");
      const transition = reduce(state, fact, env);
      this.write(transition);
      this.sql.insertReceipt.run(id, receipt);
      return transition.state;
    });
  }
  complete(id: string, effectId: string, facts: readonly unknown[], env: Environment): State {
    Key.parse(effectId);
    return this.atomic(() => {
      let state = this.required(id);
      if (!this.sql.effect.get(id, effectId)) return state;
      if (facts.length > 64) throw new Error("effect_result_backpressure");
      this.sql.deleteEffect.run(id, effectId);
      const effects: Effect[] = [];
      for (const fact of facts) {
        const next = reduce(state, fact, env);
        state = next.state;
        effects.push(...next.effects);
      }
      this.write({ state, effects });
      return state;
    });
  }
  /** Called when a cancellation obsoletes an integration intent before execution. */
  abandonIntegration(id: string, effectId: string, env: Environment): State {
    return this.atomic(() => {
      const state = this.required(id);
      if (state.phase !== "cancelling") throw new Error("run_not_cancelling");
      this.sql.deleteEffect.run(id, effectId);
      const next = reduce({ ...state, integration: null }, { type: "tick" }, env);
      this.write(next);
      return next.state;
    });
  }
  delete(id: string): void {
    const state = this.required(id);
    if (state.phase !== "done" && state.phase !== "cancelled") throw new Error("run_still_live");
    if (Count.parse(this.sql.countPending.get(id)).n > 0) throw new Error("run_effects_pending");
    this.sql.deleteRun.run(id);
  }
  private required(id: string): State {
    const state = this.load(id);
    if (!state) throw new Error("run_not_found");
    return state;
  }
  private write(transition: Transition): void {
    const state = State.parse(transition.state);
    const row = this.sql.countPending.get(state.id);
    const count = row ? Count.parse(row).n : 0;
    if (count + transition.effects.length > MAX_PENDING) throw new Error("effect_backpressure");
    this.sql.writeRun.run(state.id, JSON.stringify(state));
    const insert = this.sql.insertEffect;
    for (const effect of transition.effects)
      insert.run(state.id, effect.id, JSON.stringify(Effect.parse(effect)));
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
      "SELECT payload FROM conductor_outbox WHERE run=? ORDER BY ordinal LIMIT 1024",
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
  };
}
