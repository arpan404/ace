import {
  Run,
  ThreadId,
  type CommandId,
  type ThreadId as Id,
  type Run as Turn,
} from "@ace/protocol";
import type { GitService } from "@ace/git";
import type { Store } from "./store.ts";
/** Git snapshots bracket root turns plus their children. A new turn waits for the prior capture. */
export class RunCheckpoints {
  private store: Store;
  private git: GitService;
  private root: (id: Id) => string;
  private now: () => number;
  private flights = new Map<Id, Promise<void>>();
  private unsubscribe: () => void;
  private closing = false;
  constructor(store: Store, git: GitService, root: (id: Id) => string, now: () => number) {
    this.store = store;
    this.git = git;
    this.root = root;
    this.now = now;
    // A restarted working tree cannot prove the final boundary of an interrupted turn.
    store.atomic((db) => {
      for (const row of db
        .prepare(
          "SELECT thread_id,id AS run_id FROM view_entities WHERE collection='runs' AND json_extract(value,'$.checkpoints.state')='pending'",
        )
        .iterate()) {
        const id = ThreadId.parse(row.thread_id);
        const run = this.run(id, String(row.run_id));
        if (run?.checkpoints)
          store.appendEvents(
            id,
            [
              {
                type: "run.client.updated",
                runId: run.id,
                checkpoints: {
                  ...run.checkpoints,
                  state: "unavailable",
                  error: "daemon_restarted",
                },
              },
            ],
            now(),
          );
      }
      db.exec("DELETE FROM client_checkpoint_due; DELETE FROM client_checkpoint_start");
    });
    this.unsubscribe = store.subscribe((events) => {
      for (const event of events) {
        const p = event.payload;
        if (p.type === "run.ended") {
          const run = this.run(event.threadId, p.runId);
          if (run?.checkpoints?.state === "pending")
            store.atomic((db) =>
              db
                .prepare("INSERT OR IGNORE INTO client_checkpoint_due VALUES (?,?)")
                .run(event.threadId, p.runId),
            );
        }
        if (p.type === "thread.updated" && p.status && ["done", "failed"].includes(p.status.state))
          void this.finish(event.threadId);
      }
    });
  }
  private run(id: Id, runId: string): Turn | undefined {
    return this.store.atomic((db) => {
      const row = db
        .prepare("SELECT value FROM view_entities WHERE thread_id=? AND collection='runs' AND id=?")
        .get(id, runId);
      return row ? Run.parse(JSON.parse(String(row.value))) : undefined;
    });
  }
  private finish(id: Id): Promise<void> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    if (this.closing || this.flights.size >= 16) return Promise.resolve();
    let completed = false;
    const task = this.capturePending(id)
      .then(() => {
        completed = true;
      })
      .catch(() => {})
      .finally(() => {
        this.flights.delete(id);
        if (completed) this.drainPending();
      });
    this.flights.set(id, task);
    return task;
  }
  private drainPending(): void {
    if (this.closing || this.flights.size >= 16) return;
    const candidates = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT DISTINCT d.thread_id FROM client_checkpoint_due d JOIN threads t ON t.id=d.thread_id WHERE json_extract(t.status,'$.state') IN ('done','failed') LIMIT 17",
        )
        .all(),
    );
    for (const row of candidates) {
      const id = ThreadId.parse(row.thread_id);
      if (!this.flights.has(id)) void this.finish(id);
      if (this.flights.size >= 16) break;
    }
  }
  private async capturePending(id: Id): Promise<void> {
    const pending = this.store.atomic((db) =>
      db.prepare("SELECT run_id FROM client_checkpoint_due WHERE thread_id=? LIMIT 64").all(id),
    );
    for (const row of pending) {
      const run = this.run(id, String(row.run_id));
      if (!run?.checkpoints) {
        this.store.atomic((db) =>
          db
            .prepare("DELETE FROM client_checkpoint_due WHERE thread_id=? AND run_id=?")
            .run(id, String(row.run_id)),
        );
        continue;
      }
      let checkpoints = run.checkpoints;
      try {
        const after = await this.git.createCheckpoint({
          worktree: this.root(id),
          threadId: id,
          label: `After turn ${run.ordinal ?? run.id}`,
        });
        checkpoints = { ...checkpoints, after: after.id, state: "ready" };
      } catch {
        checkpoints = { ...checkpoints, state: "unavailable", error: "checkpoint_failed" };
      }
      this.store.atomic((db) => {
        this.store.appendEvents(
          id,
          [{ type: "run.client.updated", runId: run.id, checkpoints }],
          this.now(),
        );
        db.prepare("DELETE FROM client_checkpoint_due WHERE thread_id=? AND run_id=?").run(
          id,
          run.id,
        );
      });
    }
  }
  async beforeSend(id: Id, command: CommandId): Promise<void> {
    while (this.flights.has(id)) await this.flights.get(id);
    // Admission reserves this thread even when the maintenance pool is full.
    await this.capturePending(id);
    if (this.closing) throw new Error("daemon_shutting_down");
    let checkpoints: import("@ace/protocol").RunCheckpoints;
    try {
      const before = await this.git.createCheckpoint({
        worktree: this.root(id),
        threadId: id,
        label: `Before ${command}`,
      });
      checkpoints = { before: before.id, state: "pending" };
    } catch {
      checkpoints = { state: "unavailable", error: "checkpoint_failed" };
    }
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO client_checkpoint_start VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET command_id=excluded.command_id,checkpoints=excluded.checkpoints",
        )
        .run(id, command, JSON.stringify(checkpoints)),
    );
  }
  async settled(): Promise<void> {
    await Promise.all(this.flights.values());
  }
  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribe();
    await Promise.allSettled(this.flights.values());
  }
}
