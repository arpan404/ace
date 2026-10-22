import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";

/**
 * Which turn of its parent each delegation came from: for every generation of a delegated
 * child (and the reservation it starts as), the parent's root run current when that work was
 * asked for. An automation run owns exactly the delegations its own turn's runs began, however
 * close in time another turn starts, and a child reopened later belongs to the turn reopening it.
 */
export class DelegationOrigins {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS delegation_origins (
        child_id TEXT NOT NULL, generation INTEGER NOT NULL, parent_id TEXT NOT NULL, run_id TEXT,
        PRIMARY KEY(child_id, generation));
      CREATE INDEX IF NOT EXISTS delegation_origin_runs ON delegation_origins(parent_id, run_id);`),
    );
  }
  /** Generation `generation` of `child` was asked for by `parent` now, if not already noted. */
  note(child: ThreadId, generation: number, parent: ThreadId): void {
    this.store
      .statement("INSERT OR IGNORE INTO delegation_origins VALUES (?,?,?,?)")
      .run(child, generation, parent, this.latestRootRun(parent) ?? null);
  }
  /** Whether any generation of `child` has a noted origin (delegations made before this don't). */
  known(child: ThreadId): boolean {
    return (
      this.store
        .statement("SELECT 1 FROM delegation_origins WHERE child_id=? LIMIT 1")
        .get(child) !== undefined
    );
  }
  /** Children of `parent` with a generation begun by one of `runs`, with that generation. */
  byRuns(parent: ThreadId, runs: readonly string[]): { child: ThreadId; generation: number }[] {
    const statement = this.store.statement(
      "SELECT child_id,generation FROM delegation_origins WHERE parent_id=? AND run_id=?",
    );
    return runs.flatMap((run) =>
      statement.all(parent, run).map((row) =>
        z
          .object({ child_id: ThreadId, generation: z.number().int() })
          .transform((value) => ({ child: value.child_id, generation: value.generation }))
          .parse(row),
      ),
    );
  }
  /** The parent's newest root run: the turn any work it asks for now belongs to. */
  private latestRootRun(parent: ThreadId): string | undefined {
    const root = this.store.getThread(parent)?.rootAgentId;
    if (!root) return undefined;
    const row = this.store
      .statement(`SELECT w.id FROM view_entity_windows w
        JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection='runs' AND e.id=w.id
        WHERE w.thread_id=? AND w.collection='runs' AND json_extract(e.value,'$.agentId')=?
        ORDER BY w.created_seq DESC LIMIT 1`)
      .get(parent, root);
    return row ? z.string().parse(row.id) : undefined;
  }
}
