import { ThreadId, type Thread } from "@ace/protocol";
import type { Store } from "./store.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import { organizerSchedule, type OrganizerSchedule } from "./thread-organizer.ts";
import { HeadWatch, headStamp } from "./workspace-head-watch.ts";
import { deadlineOf, type Deadline } from "./workspace-refresh-deadline.ts";
import { followsLivePullRequest, followsPullRequest } from "./pull-request-follow.ts";

/** Quiet threads nobody is viewing still notice outside edits and commits, at a slow cadence. */
const settledCadenceMs = 600_000;
/** How often watched checkouts are checked for a commit or checkout (file stamps, no Git). */
const headCadenceMs = 5_000;
/** The longest one background read may take before the sweep moves on without it. */
const readDeadlineMs = 30_000;
/** Agents commit and switch branches from their own shells, which ace sees no event for. */
const activeStates = new Set<Thread["status"]["state"]>(["working", "waiting", "needs_you"]);

/** No agent work can be changing the checkout: nothing runs, waits or asks. */
const quietStates = new Set<Thread["status"]["state"]>(["done", "new", "failed", "limited"]);

/**
 * Whether a thread's checkout is read only at the settled cadence after a refresh: nothing in it
 * is running, no client is viewing it and no open or draft pull request can change. Any thread
 * event still makes it due at once, so agent edits are never left for the slow cadence.
 */
function settled(thread: Thread, viewed: readonly ThreadId[]): boolean {
  return (
    quietStates.has(thread.status.state) &&
    !viewed.includes(thread.id) &&
    !followsLivePullRequest(thread.details)
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
    deadline: Deadline = deadlineOf(readDeadlineMs),
  ) {
    // Threads whose agents may be moving their checkout, kept from status events: the watch
    // reads this set every few seconds and never queries the store for it.
    const active = new Set<ThreadId>(
      privateStore.atomic((db) =>
        db
          .prepare(
            `SELECT id FROM threads WHERE json_extract(status,'$.state') IN (${[...activeStates]
              .map(() => "?")
              .join(",")}) AND json_extract(client,'$.deletedAt') IS NULL`,
          )
          .all(...activeStates)
          .map((row) => ThreadId.parse(row.id)),
      ),
    );
    privateStore.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_refresh(thread_id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_refresh_due ON workspace_refresh(due);
      INSERT OR IGNORE INTO workspace_refresh SELECT id,0 FROM threads WHERE json_extract(client,'$.deletedAt') IS NULL AND (archived_at IS NULL OR id IN (SELECT thread_id FROM forge_links));`),
    );
    // A changed thread is due now, behind every thread that was due before it. A sweep takes
    // the oldest due first, so threads that keep changing cannot hold the front of the queue
    // and starve the rest.
    const dirty = (id: string) =>
      privateStore.atomic((db) =>
        db
          .prepare(
            "INSERT INTO workspace_refresh VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET due=MIN(due,excluded.due)",
          )
          .run(id, now()),
      );
    this.stop = privateStore.subscribe((events) => {
      for (const event of events) {
        const p = event.payload;
        const status =
          p.type === "thread.updated"
            ? p.status
            : p.type === "thread.created"
              ? p.thread.status
              : undefined;
        if (status && activeStates.has(status.state)) active.add(event.threadId);
        else if (status) active.delete(event.threadId);
        if (
          p.type === "thread.created" ||
          p.type === "thread.updated" ||
          p.type === "workspace.files_changed" ||
          (p.type === "thread.client.updated" && p.changes.details?.linkedPrs !== undefined)
        )
          dirty(event.threadId);
      }
    });
    // A read abandoned at its deadline may still be running. Until it ends, its thread is skipped
    // rather than queued behind it again, so one stuck checkout costs one deadline, not one a sweep.
    const reading = new Set<ThreadId>();
    const readDetails = async (id: ThreadId): Promise<boolean> => {
      if (reading.has(id)) return false;
      reading.add(id);
      await deadline(
        runtime.details(id).finally(() => reading.delete(id)),
        "details",
      );
      return true;
    };
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
        // Advance before I/O. An event during the refresh makes the thread due again.
        const advanced = now() + 60_000;
        await privateStore.write((db) =>
          db.prepare("UPDATE workspace_refresh SET due=? WHERE thread_id=?").run(advanced, id),
        );
        const thread = privateStore.getThread(id);
        if (
          !thread ||
          thread.deletedAt !== undefined ||
          (thread.archivedAt !== undefined && !followsPullRequest(thread.details))
        ) {
          await privateStore.write((db) =>
            db.prepare("DELETE FROM workspace_refresh WHERE thread_id=?").run(id),
          );
          continue;
        }
        try {
          if (!(await readDetails(id))) continue;
          if (followsPullRequest(thread.details)) refresh.push({ id, cwd: runtime.root(id) });
          const current = privateStore.getThread(id);
          if (current && settled(current, privateStore.viewedThreads()))
            await privateStore.write((db) =>
              db
                .prepare("UPDATE workspace_refresh SET due=? WHERE thread_id=? AND due=?")
                .run(now() + settledCadenceMs, id, advanced),
            );
        } catch (error) {
          report(error);
        }
      }
      if (refresh.length && !this.closed) {
        try {
          await deadline(runtime.forge.refresh(refresh), "pull requests");
        } catch (error) {
          report(error);
        }
      }
    };
    sweepAndArm();
    const heads = new HeadWatch(async (id) => headStamp(runtime.root(id)));
    // Checkouts that can move without a thread event: a terminal's, an agent's at work, and any
    // a client is looking at. Each check stats three files, so watching them costs almost nothing.
    const watched = () => [
      ...new Set([...runtime.terminalThreads(), ...privateStore.viewedThreads(), ...active]),
    ];
    const watch = () => {
      if (this.closed) return;
      this.cancelHeads = schedule(headCadenceMs, () => {
        void deadline(heads.changed(watched()), "checkout stamps")
          .then(async (moved) => {
            for (const id of moved) {
              if (this.closed) return;
              await readDetails(id).catch(report);
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
