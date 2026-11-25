import { isMutationUnavailable } from "@ace/git";
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
  private git: Pick<GitService, "createCheckpoint">;
  private root: (id: Id) => string;
  private now: () => number;
  private flights = new Map<Id, Promise<void>>();
  /** Flights `finish`/`drainPending` started: the maintenance pool's own slots. Admissions never take one. */
  private maintenance = 0;
  private unsubscribe: () => void;
  private closing = false;
  constructor(
    store: Store,
    git: Pick<GitService, "createCheckpoint">,
    root: (id: Id) => string,
    now: () => number,
  ) {
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
          // finish() swallows its own capture failure and the next drain picks the rows up.
          void this.finish(event.threadId).catch(() => {});
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
    if (this.closing || this.maintenance >= 16) return Promise.resolve();
    let completed = false;
    this.maintenance++;
    const task = this.capturePending(id)
      .then(() => {
        completed = true;
      })
      .catch(() => {})
      .finally(() => {
        this.maintenance--;
        this.flights.delete(id);
        // Due rows stay stored and the next finished thread drains them: an unreadable store
        // here must not reject this flight, which nothing awaits.
        if (completed)
          try {
            this.drainPending();
          } catch {
            // Left for the next drain.
          }
      });
    this.flights.set(id, task);
    return task;
  }
  private drainPending(): void {
    if (this.closing || this.maintenance >= 16) return;
    const candidates = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT DISTINCT d.thread_id FROM client_checkpoint_due d JOIN threads t ON t.id=d.thread_id WHERE json_extract(t.status,'$.state') IN ('done','failed') LIMIT 17",
        )
        .all(),
    );
    for (const row of candidates) {
      const id = ThreadId.parse(row.thread_id);
      // finish() swallows its own capture failure and the next drain picks the rows up.
      if (!this.flights.has(id)) void this.finish(id).catch(() => {});
      if (this.maintenance >= 16) break;
    }
  }
  /** The thread's latest root turn the turn order knows, whether or not it is still due. */
  private latestIndexedRoot(id: Id): string | undefined {
    return this.store.atomic((db) => {
      const row = db
        .prepare(
          "SELECT run_id FROM client_run_index WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1",
        )
        .get(id);
      return row ? String(row.run_id) : undefined;
    });
  }
  /**
   * Captures every due "after" snapshot; returns the latest root turn's, once it is captured.
   * Only that one can lend its tree to the next turn, so it is captured last: anything captured
   * after it would be a later state of the same checkout.
   */
  private async capturePending(id: Id): Promise<string | undefined> {
    const pending = this.store.atomic((db) =>
      db.prepare("SELECT run_id FROM client_checkpoint_due WHERE thread_id=? LIMIT 64").all(id),
    );
    const shared = this.latestIndexedRoot(id);
    for (const row of pending) {
      const runId = String(row.run_id);
      if (runId !== shared) await this.captureAfter(id, runId);
    }
    if (shared === undefined || !pending.some((row) => String(row.run_id) === shared))
      return undefined;
    return this.captureAfter(id, shared);
  }
  /** Writes one due row's "after" snapshot and clears it; its checkpoint id when it succeeded. */
  private async captureAfter(id: Id, runId: string): Promise<string | undefined> {
    const run = this.run(id, runId);
    if (!run?.checkpoints) {
      this.store.atomic((db) =>
        db
          .prepare("DELETE FROM client_checkpoint_due WHERE thread_id=? AND run_id=?")
          .run(id, runId),
      );
      return undefined;
    }
    let checkpoints = run.checkpoints;
    let after: string | undefined;
    try {
      const checkpoint = await this.git.createCheckpoint({
        worktree: this.root(id),
        threadId: id,
        label: `After turn ${run.ordinal ?? run.id}`,
      });
      after = checkpoint.id;
      checkpoints = { ...checkpoints, after, state: "ready" };
    } catch (error) {
      checkpoints = {
        ...checkpoints,
        state: "unavailable",
        error: isMutationUnavailable(error) ? "git_quarantined" : "checkpoint_failed",
      };
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
    return after;
  }
  async beforeSend(id: Id, command: CommandId): Promise<void> {
    while (this.flights.has(id)) await this.flights.get(id);
    // Admission holds this thread itself, over the whole capture and before, so no maintenance
    // pass can capture the same due rows again. It never waits for the maintenance pool.
    let failure: unknown;
    let failed = false;
    const task = this.admit(id, command)
      .catch((error: unknown) => {
        failed = true;
        failure = error;
      })
      .finally(() => {
        this.flights.delete(id);
        // A failed admission leaves due rows behind the way a successful one may, so the next
        // drain gets the same chance either way.
        try {
          this.drainPending();
        } catch {
          // Left for the next drain.
        }
      });
    this.flights.set(id, task);
    await task;
    if (failed) throw failure;
  }
  private async admit(id: Id, command: CommandId): Promise<void> {
    const pendingAfter = await this.capturePending(id);
    if (this.closing) throw new Error("daemon_shutting_down");
    let checkpoints: import("@ace/protocol").RunCheckpoints;
    let unavailable: unknown;
    // The turn that just ended left its "after" snapshot above, under this same admission hold
    // with nothing running in between: the new turn starts from that tree, so no second "before"
    // snapshot of it is taken.
    if (pendingAfter !== undefined) {
      checkpoints = { before: pendingAfter, state: "pending" };
    } else {
      try {
        const before = await this.git.createCheckpoint({
          worktree: this.root(id),
          threadId: id,
          label: `Before ${command}`,
        });
        checkpoints = { before: before.id, state: "pending" };
      } catch (error) {
        if (isMutationUnavailable(error)) unavailable = error;
        checkpoints = {
          state: "unavailable",
          error: isMutationUnavailable(error) ? "git_quarantined" : "checkpoint_failed",
        };
      }
    }
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO client_checkpoint_start VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET command_id=excluded.command_id,checkpoints=excluded.checkpoints",
        )
        .run(id, command, JSON.stringify(checkpoints)),
    );
    if (unavailable) throw unavailable;
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
