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
 * When a native subagent of the parent asked, the turn is the one whose root run started that
 * subagent, however many turns later it asks. `noted_seq` orders generations against each other.
 */
export type OriginOwner =
  /** The parent's agent `agentId` asked (absent: its root agent). */
  | { kind: "parent-turn"; agentId?: string | undefined }
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
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(delegation_origins)")
          .all()
          .map((row) => String(row.name)),
      );
      if (!columns.has("kind"))
        db.exec("ALTER TABLE delegation_origins ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn'");
      if (!columns.has("noted_seq"))
        db.exec("ALTER TABLE delegation_origins ADD COLUMN noted_seq INTEGER NOT NULL DEFAULT 0");
    });
  }
  /** Generation `generation` of `child` of `parent` now belongs to `owner`, if not noted yet. */
  note(child: ThreadId, generation: number, parent: ThreadId, owner: OriginOwner): void {
    const value =
      owner.kind === "parent-turn"
        ? { kind: "turn", run: this.runOfAgent(parent, owner.agentId, undefined) }
        : owner.kind === "independent"
          ? { kind: "independent", run: undefined }
          : this.carried(child, owner.generation);
    this.store
      .statement(
        "INSERT OR IGNORE INTO delegation_origins(child_id,generation,parent_id,run_id,kind,noted_seq) VALUES (?,?,?,?,?,?)",
      )
      .run(child, generation, parent, value.run ?? null, value.kind, this.store.headSeq());
  }
  /** Who owns generation `generation` of `child`, and when it was noted. */
  owner(
    child: ThreadId,
    generation: number,
  ): { kind: "turn" | "independent" | "uncertain"; run?: string; seq: number } | undefined {
    const row = this.store
      .statement(
        "SELECT kind,run_id,noted_seq FROM delegation_origins WHERE child_id=? AND generation=?",
      )
      .get(child, generation);
    if (!row) return undefined;
    const value = Row.extend({ noted_seq: z.number() }).parse(row);
    return {
      kind: value.kind,
      ...(value.run_id === null ? {} : { run: value.run_id }),
      seq: value.noted_seq,
    };
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
      parentAgentId: string;
      generation: number;
      createdAt: number;
      live: boolean;
    }[],
  ): void {
    this.store.atomic((db) => {
      if (this.backfilled()) return;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO delegation_origins(child_id,generation,parent_id,run_id,kind,noted_seq) VALUES (?,?,?,?,?,0)",
      );
      for (const edge of edges) {
        insert.run(
          edge.childId,
          0,
          edge.parentId,
          this.runOfAgent(edge.parentId, edge.parentAgentId, edge.createdAt) ?? null,
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
  /**
   * The parent's root run a request by its agent `agentId` belongs to. The root agent asks
   * within its run current at `at` (now, when undefined). A native subagent asks on behalf of
   * the root run that started it: the root run current when its top ancestor below the root
   * appeared.
   */
  private runOfAgent(
    parent: ThreadId,
    agentId: string | undefined,
    at: number | undefined,
  ): string | undefined {
    const root = this.store.getThread(parent)?.rootAgentId;
    if (!root) return undefined;
    const started =
      agentId === undefined || agentId === root ? undefined : this.startedAt(parent, root, agentId);
    if (started !== undefined) return this.rootRun(parent, root, "AND w.created_seq<=?", started);
    return this.rootRun(
      parent,
      root,
      "AND (? IS NULL OR json_extract(e.value,'$.startedAt')<=?)",
      at ?? null,
      at ?? null,
    );
  }
  /** When the top ancestor below the root of native agent `agentId` appeared (its event seq). */
  private startedAt(parent: ThreadId, root: string, agentId: string): number | undefined {
    const read = this.store.statement(`SELECT e.value,w.created_seq AS seq FROM view_entities e
      JOIN view_entity_windows w ON w.thread_id=e.thread_id AND w.collection=e.collection AND w.id=e.id
      WHERE e.thread_id=? AND e.collection='agents' AND e.id=?`);
    let current = agentId;
    for (let depth = 0; depth < 16; depth++) {
      const row = read.get(parent, current);
      if (!row) return undefined;
      const value = z
        .object({ parentId: z.string().nullable().optional() })
        .safeParse(JSON.parse(z.string().parse(row.value)));
      const above = value.success ? value.data.parentId : undefined;
      if (!above || above === root) return Number(row.seq);
      current = above;
    }
    return undefined;
  }
  private rootRun(
    parent: ThreadId,
    root: string,
    filter: string,
    ...values: (string | number | null)[]
  ) {
    const row = this.store
      .statement(`SELECT w.id FROM view_entity_windows w
        JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection='runs' AND e.id=w.id
        WHERE w.thread_id=? AND w.collection='runs' AND json_extract(e.value,'$.agentId')=? ${filter}
        ORDER BY w.created_seq DESC LIMIT 1`)
      .get(parent, root, ...values);
    return row ? z.string().parse(row.id) : undefined;
  }
}
