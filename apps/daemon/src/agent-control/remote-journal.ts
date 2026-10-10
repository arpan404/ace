import { pruneRemoteRows } from "./remote-retention.ts";
import { z } from "zod";
import { RemoteTask } from "@ace/protocol";
import type { Store } from "../store.ts";

/** The originating daemon owns the sole durable task ledger; broker windows hold no run state. */
export class RemoteTaskJournal {
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
