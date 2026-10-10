import { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import { organizerSchedule, type OrganizerSchedule } from "./thread-organizer.ts";

/** Indexed, durable dirty/deadline queue. A refresh touches at most eight current trees. */
export class WorkspaceRefresh {
  private stop: () => void;
  private cancel: (() => void) | undefined;
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
    const arm = () => {
      if (this.closed) return;
      this.cancel = schedule(60_000, () => {
        this.pending = sweep().finally(() => {
          this.pending = undefined;
          arm();
        });
      });
    };
    const sweep = async () => {
      const ids = privateStore.atomic((db) =>
        db
          .prepare("SELECT thread_id FROM workspace_refresh WHERE due<=? ORDER BY due LIMIT 8")
          .all(now())
          .map((row) => ThreadId.parse(row.thread_id)),
      );
      const refresh: { id: ThreadId; cwd: string }[] = [];
      for (const id of ids) {
        if (this.closed) return;
        // Advance before I/O. An event during the refresh resets due to zero.
        privateStore.atomic((db) =>
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
          privateStore.atomic((db) =>
            db.prepare("DELETE FROM workspace_refresh WHERE thread_id=?").run(id),
          );
          continue;
        }
        try {
          await runtime.details(id);
          if (thread.details?.linkedPrs?.length || thread.details?.linkedPr)
            refresh.push({ id, cwd: runtime.root(id) });
          const current = privateStore.getThread(id);
          if (
            current?.status.state === "done" &&
            !current.details?.linkedPrs?.length &&
            !current.details?.linkedPr
          )
            privateStore.atomic((db) =>
              db.prepare("DELETE FROM workspace_refresh WHERE thread_id=? AND due>0").run(id),
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
    this.pending = sweep().finally(() => {
      this.pending = undefined;
      arm();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    this.cancel?.();
    await this.pending;
  }
}
