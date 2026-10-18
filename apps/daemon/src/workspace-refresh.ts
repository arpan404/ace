import { ThreadId, type Thread } from "@ace/protocol";
import type { Store } from "./store.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import { organizerSchedule, type OrganizerSchedule } from "./thread-organizer.ts";
import { HeadWatch, headStamp } from "./workspace-head-watch.ts";

/** Quiet threads nobody is viewing still notice outside edits and commits, at a slow cadence. */
const settledCadenceMs = 600_000;
/** How often threads with an open terminal are checked for a commit or checkout. */
const headCadenceMs = 5_000;

/** No agent work can be changing the checkout: nothing runs, waits or asks. */
const quietStates = new Set<Thread["status"]["state"]>(["done", "new", "failed", "limited"]);

/**
 * Whether a thread's checkout is read only at the settled cadence after a refresh: nothing in it
 * is running, no client is viewing it and it has no pull request to follow. Any thread event
 * still makes it due at once, so agent edits are never left for the slow cadence.
 */
function settled(thread: Thread, viewed: readonly ThreadId[]): boolean {
  return (
    quietStates.has(thread.status.state) &&
    !viewed.includes(thread.id) &&
    !thread.details?.linkedPrs?.length &&
    !thread.details?.linkedPr
  );
}

/** Indexed, durable dirty/deadline queue. A refresh touches at most eight current trees. */
export class WorkspaceRefresh {
  private stop: () => void;
  private cancel: (() => void) | undefined;
  private cancelHeads: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;
  constructor(
    privateStore: Store,
    runtime: WorkspaceRuntime,
    now: () => number,
    schedule: OrganizerSchedule = organizerSchedule,
    report: (error: unknown) => void = () => {},
  ) {
    privateStore.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_refresh(thread_id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_refresh_due ON workspace_refresh(due);
      INSERT OR IGNORE INTO workspace_refresh SELECT id,0 FROM threads WHERE json_extract(client,'$.deletedAt') IS NULL AND (archived_at IS NULL OR id IN (SELECT thread_id FROM forge_links));`),
    );
    const dirty = (id: string) =>
      privateStore.atomic((db) =>
        db
          .prepare(
            "INSERT INTO workspace_refresh VALUES (?,0) ON CONFLICT(thread_id) DO UPDATE SET due=0",
          )
          .run(id),
      );
    this.stop = privateStore.subscribe((events) => {
      for (const event of events) {
        const p = event.payload;
        if (
          p.type === "thread.created" ||
          p.type === "thread.updated" ||
          p.type === "workspace.files_changed" ||
          (p.type === "thread.client.updated" && p.changes.details?.linkedPrs !== undefined)
        )
          dirty(event.threadId);
      }
    });
    // A failed sweep, including one that finds the store busy, is reported and tried again
    // next cycle. It never rejects into the timer, where it would end the daemon.
    const sweepAndArm = () => {
      this.pending = sweep()
        .catch(report)
        .finally(() => {
          this.pending = undefined;
          arm();
        });
    };
    const arm = () => {
      if (this.closed) return;
      this.cancel = schedule(60_000, sweepAndArm);
    };
    const sweep = async () => {
      const viewed = privateStore.viewedThreads();
      const ids = privateStore.atomic((db) => {
        // A thread someone is looking at is read at the active cadence, whatever its state.
        const due = db.prepare("UPDATE workspace_refresh SET due=MIN(due,?) WHERE thread_id=?");
        for (const id of viewed) due.run(now(), id);
        return db
          .prepare("SELECT thread_id FROM workspace_refresh WHERE due<=? ORDER BY due LIMIT 8")
          .all(now())
          .map((row) => ThreadId.parse(row.thread_id));
      });
      const refresh: { id: ThreadId; cwd: string }[] = [];
      for (const id of ids) {
        if (this.closed) return;
        // Advance before I/O. An event during the refresh resets due to zero.
        await privateStore.write((db) =>
          db
            .prepare("UPDATE workspace_refresh SET due=? WHERE thread_id=?")
            .run(now() + 60_000, id),
        );
        const thread = privateStore.getThread(id);
        if (
          !thread ||
          thread.deletedAt !== undefined ||
          (thread.archivedAt !== undefined &&
            !thread.details?.linkedPrs?.length &&
            !thread.details?.linkedPr)
        ) {
          await privateStore.write((db) =>
            db.prepare("DELETE FROM workspace_refresh WHERE thread_id=?").run(id),
          );
          continue;
        }
        try {
          await runtime.details(id);
          if (thread.details?.linkedPrs?.length || thread.details?.linkedPr)
            refresh.push({ id, cwd: runtime.root(id) });
          const current = privateStore.getThread(id);
          if (current && settled(current, privateStore.viewedThreads()))
            await privateStore.write((db) =>
              db
                .prepare("UPDATE workspace_refresh SET due=? WHERE thread_id=? AND due>0")
                .run(now() + settledCadenceMs, id),
            );
        } catch (error) {
          report(error);
        }
      }
      if (refresh.length && !this.closed) {
        try {
          await runtime.forge.refresh(refresh);
        } catch (error) {
          report(error);
        }
      }
    };
    sweepAndArm();
    const heads = new HeadWatch(async (id) => headStamp(runtime.root(id)));
    const watch = () => {
      if (this.closed) return;
      this.cancelHeads = schedule(headCadenceMs, () => {
        void heads
          .changed(runtime.terminalThreads())
          .then(async (moved) => {
            for (const id of moved) {
              if (this.closed) return;
              await runtime.details(id).catch(report);
            }
          })
          .catch(report)
          .finally(watch);
      });
    };
    watch();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    this.cancel?.();
    this.cancelHeads?.();
    await this.pending;
  }
}
