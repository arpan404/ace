import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";

/**
 * Who each generation of a delegated child belongs to, so an automation run sees and stops
 * exactly the delegated work its own turn began:
 * - `turn`: the parent agent asked for it, during its root run `run_id` (a new delegation, or
 *   the parent's own message reopening a settled child);
 * - `independent`: someone else reopened the child (the person writing to it directly), so no
 *   turn of the parent owns it;
 * - `uncertain`: live work from before ownership was kept whose owner history can't establish.
 *   It holds an automation run in that thread open and no pause ever cancels it.
 * A native revival carries on the generation it revives and keeps that generation's owner.
 */
export type OriginOwner =
  | { kind: "parent-turn" }
  | { kind: "independent" }
  | { kind: "same-as"; generation: number };

const Row = z.object({
  kind: z.enum(["turn", "independent", "uncertain"]),
  run_id: z.string().nullable(),
});

export class DelegationOrigins {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS delegation_origins (
        child_id TEXT NOT NULL, generation INTEGER NOT NULL, parent_id TEXT NOT NULL, run_id TEXT,
        kind TEXT NOT NULL DEFAULT 'turn', PRIMARY KEY(child_id, generation));
      CREATE INDEX IF NOT EXISTS delegation_origin_runs ON delegation_origins(parent_id, run_id);
      CREATE TABLE IF NOT EXISTS delegation_origin_backfill (id INTEGER PRIMARY KEY);`);
      const columns = db
        .prepare("PRAGMA table_info(delegation_origins)")
        .all()
        .map((row) => String(row.name));
      if (!columns.includes("kind"))
        db.exec("ALTER TABLE delegation_origins ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn'");
    });
  }
  /** Generation `generation` of `child` of `parent` now belongs to `owner`, if not noted yet. */
  note(child: ThreadId, generation: number, parent: ThreadId, owner: OriginOwner): void {
    const value =
      owner.kind === "parent-turn"
        ? { kind: "turn", run: this.rootRunAt(parent, undefined) }
        : owner.kind === "independent"
          ? { kind: "independent", run: undefined }
          : this.carried(child, owner.generation);
    this.store
      .statement("INSERT OR IGNORE INTO delegation_origins VALUES (?,?,?,?,?)")
      .run(child, generation, parent, value.run ?? null, value.kind);
  }
  /** Children of `parent` with a generation one of `runs` began, with that generation. */
  byRuns(parent: ThreadId, runs: readonly string[]): { child: ThreadId; generation: number }[] {
    const statement = this.store.statement(
      "SELECT child_id,generation FROM delegation_origins WHERE parent_id=? AND run_id=? AND kind='turn'",
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
  /** Whether generation `generation` of `child` has no owner anyone can establish. */
  uncertain(child: ThreadId, generation: number): boolean {
    const row = this.store
      .statement("SELECT kind FROM delegation_origins WHERE child_id=? AND generation=?")
      .get(child, generation);
    return !row || row.kind === "uncertain";
  }
  backfilled(): boolean {
    return (
      this.store.statement("SELECT 1 FROM delegation_origin_backfill WHERE id=1").get() !==
      undefined
    );
  }
  /**
   * Once, for delegations made before owners were kept: a first generation belongs to the
   * parent's root run current when the child was made, as the run history shows; a reopened
   * generation still live has no history of who reopened it, so it is uncertain.
   */
  backfill(
    edges: readonly {
      childId: ThreadId;
      parentId: ThreadId;
      generation: number;
      createdAt: number;
      live: boolean;
    }[],
  ): void {
    this.store.atomic((db) => {
      if (this.backfilled()) return;
      const insert = db.prepare("INSERT OR IGNORE INTO delegation_origins VALUES (?,?,?,?,?)");
      for (const edge of edges) {
        insert.run(
          edge.childId,
          0,
          edge.parentId,
          this.rootRunAt(edge.parentId, edge.createdAt) ?? null,
          "turn",
        );
        if (edge.generation > 0 && edge.live)
          insert.run(edge.childId, edge.generation, edge.parentId, null, "uncertain");
      }
      db.exec("INSERT INTO delegation_origin_backfill VALUES (1)");
    });
  }
  private carried(child: ThreadId, generation: number) {
    const row = this.store
      .statement("SELECT kind,run_id FROM delegation_origins WHERE child_id=? AND generation=?")
      .get(child, generation);
    const value = row ? Row.parse(row) : undefined;
    return { kind: value?.kind ?? "uncertain", run: value?.run_id ?? undefined };
  }
  /** The parent's root run current at `at` (now, when undefined): the turn its asks belong to. */
  private rootRunAt(parent: ThreadId, at: number | undefined): string | undefined {
    const root = this.store.getThread(parent)?.rootAgentId;
    if (!root) return undefined;
    const row = this.store
      .statement(`SELECT w.id FROM view_entity_windows w
        JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection='runs' AND e.id=w.id
        WHERE w.thread_id=? AND w.collection='runs' AND json_extract(e.value,'$.agentId')=?
        AND (? IS NULL OR json_extract(e.value,'$.startedAt')<=?)
        ORDER BY w.created_seq DESC LIMIT 1`)
      .get(parent, root, at ?? null, at ?? null);
    return row ? z.string().parse(row.id) : undefined;
  }
}
