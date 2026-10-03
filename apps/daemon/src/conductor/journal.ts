import type { State } from "@ace/conductor";
import { z } from "zod";
import { AgentId, ThreadId, WorkspaceId } from "@ace/protocol";
import type { Store } from "../store.ts";

export const RootBinding = z.object({
  run: z.string(),
  thread: ThreadId,
  agent: AgentId,
  repo: z.string(),
  baseBranch: z.string().nullable().default(null),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
});
export type RootBinding = z.infer<typeof RootBinding>;
export const LaneBinding = z.object({
  run: z.string(),
  lane: z.string(),
  generation: z.number().int().nonnegative(),
  thread: ThreadId,
  workspace: WorkspaceId.nullable(),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  request: z.string(),
  workstream: z.string().nullable(),
});
export type LaneBinding = z.infer<typeof LaneBinding>;

/** Identities are committed before worktree effects; bindings survive retired reducer lanes. */
export class ExecutionJournal {
  constructor(privateStore: Store) {
    this.store = privateStore;
    privateStore.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS conductor_execution_roots (run TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conductor_execution_lanes (run TEXT NOT NULL, lane TEXT NOT NULL, generation INTEGER NOT NULL, thread TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,lane,generation));
      CREATE TABLE IF NOT EXISTS conductor_gate_interactions (interaction TEXT PRIMARY KEY, run TEXT NOT NULL, gate TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conductor_execution_thread ON conductor_execution_lanes(thread);
    `),
    );
  }
  private store: Store;
  gate(interaction: string) {
    const row = this.store.atomic((db) =>
      db
        .prepare("SELECT run,gate FROM conductor_gate_interactions WHERE interaction=?")
        .get(interaction),
    );
    return row ? z.object({ run: z.string(), gate: z.string() }).parse(row) : undefined;
  }
  saveGate(interaction: string, run: string, gate: string) {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR REPLACE INTO conductor_gate_interactions VALUES (?,?,?)")
        .run(interaction, run, gate),
    );
  }
  root(run: string) {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT payload FROM conductor_execution_roots WHERE run=?").get(run),
    );
    return row ? RootBinding.parse(JSON.parse(z.string().parse(row.payload))) : undefined;
  }
  saveRoot(root: RootBinding) {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO conductor_execution_roots VALUES (?,?)")
        .run(root.run, JSON.stringify(root)),
    );
  }
  save(binding: LaneBinding) {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO conductor_execution_lanes VALUES (?,?,?,?,?) ON CONFLICT(run,lane,generation) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          binding.run,
          binding.lane,
          binding.generation,
          binding.thread,
          JSON.stringify(binding),
        ),
    );
  }
  lane(run: string, lane: string, generation: number) {
    const row = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT payload FROM conductor_execution_lanes WHERE run=? AND lane=? AND generation=?",
        )
        .get(run, lane, generation),
    );
    return row ? LaneBinding.parse(JSON.parse(z.string().parse(row.payload))) : undefined;
  }
  latest(run: string, lane: string) {
    const row = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT payload FROM conductor_execution_lanes WHERE run=? AND lane=? ORDER BY generation DESC LIMIT 1",
        )
        .get(run, lane),
    );
    return row ? LaneBinding.parse(JSON.parse(z.string().parse(row.payload))) : undefined;
  }
  current(state: State) {
    return Object.values(state.lanes).flatMap((lane) => {
      if (!lane.live) return [];
      const binding =
        this.lane(state.id, lane.id, lane.generation) ?? this.latest(state.id, lane.id);
      return binding ? [binding] : [];
    });
  }
  lanes(run: string) {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT payload FROM conductor_execution_lanes WHERE run=? ORDER BY rowid DESC LIMIT 256",
          )
          .all(run),
      )
      .map((row) => LaneBinding.parse(JSON.parse(z.string().parse(row.payload))));
  }
  forThread(thread: ThreadId) {
    const row = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT payload FROM conductor_execution_lanes WHERE thread=? ORDER BY generation DESC LIMIT 1",
        )
        .get(thread),
    );
    return row ? LaneBinding.parse(JSON.parse(z.string().parse(row.payload))) : undefined;
  }
}
