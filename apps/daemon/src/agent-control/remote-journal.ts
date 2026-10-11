import { pruneRemoteRows } from "./remote-retention.ts";
import { z } from "zod";
import { RemoteTask } from "@ace/protocol";
import type { Store } from "../store.ts";

const reconciliationMs = 7 * 24 * 60 * 60 * 1000;
const reconciling = `terminal=1 AND json_extract(record,'$.phase')='failed'
  AND json_extract(record,'$.cancellingAt') IS NOT NULL
  AND json_extract(record,'$.result') IS NULL AND json_extract(record,'$.finishedAt')>?`;

/** The originating daemon owns the sole durable task ledger; broker windows hold no run state. */
export class RemoteTaskJournal {
  private pollCursor = "";
  constructor(privateStore: Store) {
    this.store = privateStore;
    this.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS remote_agent_tasks (
      id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL, terminal INTEGER NOT NULL DEFAULT 0,
      record JSON NOT NULL
    ); CREATE INDEX IF NOT EXISTS remote_tasks_active ON remote_agent_tasks(terminal,id); CREATE INDEX IF NOT EXISTS remote_tasks_root ON remote_agent_tasks(root_id,id);`),
    );
  }
  private store: Store;
  get(id: string): RemoteTask | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT record FROM remote_agent_tasks WHERE id=?").get(id),
    );
    return row ? RemoteTask.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  active(): RemoteTask[] {
    return this.store
      .atomic((db) =>
        db
          .prepare("SELECT record FROM remote_agent_tasks WHERE terminal=0 ORDER BY id LIMIT 64")
          .all(),
      )
      .map((row) => RemoteTask.parse(JSON.parse(z.string().parse(row.record))));
  }
  /** Delivered cancellation warnings still need a bounded query for the target's sealed answer. */
  reconciling(now: number): RemoteTask[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            `SELECT record FROM remote_agent_tasks WHERE ${reconciling} ORDER BY id LIMIT 64`,
          )
          .all(now - reconciliationMs),
      )
      .map((row) => RemoteTask.parse(JSON.parse(z.string().parse(row.record))));
  }
  /** A page omission is not removal. Confirm eligibility against the source ledger. */
  inactive(ids: readonly string[], now: number): string[] {
    if (!ids.length) return [];
    const live = new Set(
      this.store
        .atomic((db) =>
          db
            .prepare(`SELECT id FROM remote_agent_tasks
            WHERE id IN (${ids.map(() => "?").join(",")}) AND (terminal=0 OR (${reconciling}))`)
            .all(...ids, now - reconciliationMs),
        )
        .map((row) => z.string().parse(row.id)),
    );
    return ids.filter((id) => !live.has(id));
  }
  /** One wire-sized batch, with cancellation priority and a rotating share for all other work. */
  poll(now: number): RemoteTask[] {
    return this.store.atomic((db) => {
      const priority = db
        .prepare(`SELECT id,record FROM remote_agent_tasks WHERE terminal=0
          AND json_extract(record,'$.phase')='cancelling' ORDER BY id LIMIT 32`)
        .all();
      const excluded = priority.map((row) => z.string().parse(row.id));
      const slots = 64 - priority.length;
      const select = (comparison: ">" | "<=", limit: number) =>
        db
          .prepare(`SELECT id,record FROM (
          SELECT id,record FROM remote_agent_tasks WHERE terminal=0 AND id${comparison}?
          UNION ALL
          SELECT id,record FROM remote_agent_tasks WHERE id${comparison}? AND ${reconciling}
        ) ${excluded.length ? `WHERE id NOT IN (${excluded.map(() => "?").join(",")})` : ""}
        ORDER BY id LIMIT ?`)
          .all(this.pollCursor, this.pollCursor, now - reconciliationMs, ...excluded, limit);
      const rotated = select(">", slots);
      if (rotated.length < slots) rotated.push(...select("<=", slots - rotated.length));
      const last = rotated.at(-1);
      if (last) this.pollCursor = z.string().parse(last.id);
      return [...priority, ...rotated].map((row) =>
        RemoteTask.parse(JSON.parse(z.string().parse(row.record))),
      );
    });
  }
  save(task: RemoteTask) {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO remote_agent_tasks(id,parent_id,root_id,terminal,record) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET terminal=excluded.terminal,record=excluded.record",
        )
        .run(
          task.id,
          task.parentThreadId,
          task.rootThreadId,
          task.delivered ? 1 : 0,
          JSON.stringify(RemoteTask.parse(task)),
        ),
    );
  }
  root(root: string) {
    const tasks = this.store
      .atomic((db) =>
        db
          .prepare("SELECT record FROM remote_agent_tasks WHERE root_id=? ORDER BY id LIMIT 10000")
          .all(root),
      )
      .map((row) => RemoteTask.parse(JSON.parse(z.string().parse(row.record))));
    return {
      children: tasks.length,
      usage: tasks.reduce(
        (sum, task) => ({
          tokens: Math.min(Number.MAX_SAFE_INTEGER, sum.tokens + task.usage.tokens),
          cost: sum.cost + task.usage.cost,
        }),
        { tokens: 0, cost: 0 },
      ),
    };
  }
  prune(now: number) {
    pruneRemoteRows(this.store, now);
  }
  count(): number {
    return Number(
      this.store.atomic(
        (db) =>
          db.prepare("SELECT COUNT(*) AS n FROM remote_agent_tasks WHERE terminal=0").get()?.n,
      ),
    );
  }
}
