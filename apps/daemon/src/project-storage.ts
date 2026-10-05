import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { Project, ThreadId, type WorkspaceId, type WorkspaceChanged } from "@ace/protocol";
import type { Store } from "./store.ts";
import { ProjectError } from "./project-policy.ts";

const recentRow = z.object({ path: Project.shape.path, opened_at: z.number().nonnegative() });
const folderRow = z.object({ opened_at: z.number().nonnegative().nullable() });

export function migrateProjects(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_unregistered (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), removed_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS workspace_recent (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), opened_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS threads_project_order ON threads(workspace_id, id);
  CREATE INDEX IF NOT EXISTS workspace_recent_order ON workspace_recent(opened_at DESC, workspace_id);`);
}
export class ProjectStorage {
  private store: Store;
  private now: () => number;
  private listeners = new Set<(change: WorkspaceChanged) => void>();
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }
  subscribe(listener: (change: WorkspaceChanged) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(change: WorkspaceChanged): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        /* Delivery cannot undo a committed registration. */
      }
    }
  }
  get(id: WorkspaceId): Project {
    return this.store.atomic((db) => {
      const row = db
        .prepare(
          "SELECT id,name,path FROM workspaces WHERE id=? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id)",
        )
        .get(id);
      if (!row) throw new ProjectError("workspace_not_found");
      return Project.parse(row);
    });
  }
  register(path: string, name: string): Project {
    let added = false;
    const workspace = this.store.atomic((db) => {
      const existing = db
        .prepare(
          "SELECT c.workspace_id FROM workspace_canonical_roots c JOIN workspaces w ON w.id=c.workspace_id WHERE c.root=? ORDER BY (w.path=?) DESC,c.workspace_id LIMIT 1",
        )
        .get(path, path);
      const existingId = existing ? Project.shape.id.parse(existing.workspace_id) : undefined;
      added =
        existingId === undefined ||
        Boolean(
          db.prepare("SELECT 1 FROM workspace_unregistered WHERE workspace_id=?").get(existingId),
        );
      const id = existingId ?? this.store.createWorkspace(path, name, this.now());
      db.prepare("UPDATE workspaces SET path=? WHERE id=?").run(path, id);
      db.prepare("DELETE FROM workspace_unregistered WHERE workspace_id=?").run(id);
      db.prepare(
        "INSERT INTO workspace_recent VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET opened_at=excluded.opened_at",
      ).run(id, this.now());
      return this.get(id);
    });
    if (added)
      this.emit({
        type: "workspace.changed",
        change: "added",
        workspaceId: workspace.id,
        workspace,
      });
    return workspace;
  }
  recent(limit: number): Project[] {
    return this.store.atomic((db) =>
      db
        .prepare(`SELECT w.id,w.name,w.path FROM workspace_recent r JOIN workspaces w ON w.id=r.workspace_id
      WHERE NOT EXISTS (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
      ORDER BY r.opened_at DESC,w.id LIMIT ?`)
        .all(limit)
        .map((row) => Project.parse(row)),
    );
  }
  recentHints(limit: number) {
    return this.store.atomic((db) =>
      db
        .prepare(`SELECT w.path,r.opened_at FROM workspace_recent r
      JOIN workspaces w ON w.id=r.workspace_id WHERE NOT EXISTS
      (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
      ORDER BY r.opened_at DESC,w.id LIMIT ?`)
        .all(limit)
        .map((row, index) => {
          const decoded = recentRow.parse(row);
          return {
            path: decoded.path,
            lastOpened: decoded.opened_at,
            recentScore: 1 / (index + 1),
          };
        }),
    );
  }
  folderFacts(path: string) {
    const row = this.store.atomic((db) =>
      db
        .prepare(`SELECT r.opened_at FROM workspaces w
      LEFT JOIN workspace_recent r ON r.workspace_id=w.id WHERE w.path=? AND NOT EXISTS
      (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id) LIMIT 1`)
        .get(path),
    );
    const decoded = row === undefined ? undefined : folderRow.parse(row);
    return {
      isProject: decoded !== undefined,
      ...(decoded?.opened_at == null ? {} : { lastOpened: decoded.opened_at }),
    };
  }
  rename(id: WorkspaceId, name: string): Project {
    const workspace = this.store.atomic((db) => {
      this.get(id);
      db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(name, id);
      this.forThreads(id, (threadId) => {
        const thread = this.store.getThread(threadId);
        const details = thread?.details;
        if (details?.workspace)
          this.store.appendEvents(
            threadId,
            [
              {
                type: "thread.client.updated",
                changes: { details: { ...details, workspace: { ...details.workspace, name } } },
              },
            ],
            this.now(),
          );
      });
      return this.get(id);
    });
    this.emit({ type: "workspace.changed", change: "renamed", workspaceId: id, workspace });
    return workspace;
  }
  remove(id: WorkspaceId, archiveThreads: boolean, hasOwnedWork: (id: ThreadId) => boolean): void {
    this.store.atomic((db) => {
      const workspace = this.get(id);
      this.store.workspaceReservations.assertAvailable(
        this.store.workspaceReservations.workspaceRoot(id, workspace.path),
      );
      this.forThreads(id, (threadId) => {
        const thread = this.store.getThread(threadId);
        if (!thread || thread.deletedAt !== undefined) return;
        if (
          !archiveThreads &&
          (!["new", "done", "failed"].includes(thread.status.state) || hasOwnedWork(threadId))
        )
          throw new ProjectError("workspace_threads_running");
        if (archiveThreads && thread.archivedAt === undefined)
          this.store.appendEvents(
            threadId,
            [{ type: "thread.updated", archivedAt: this.now() }],
            this.now(),
          );
      });
      db.prepare(
        "INSERT INTO workspace_unregistered VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET removed_at=excluded.removed_at",
      ).run(id, this.now());
    });
    this.emit({ type: "workspace.changed", change: "removed", workspaceId: id });
  }
  private forThreads(id: WorkspaceId, visit: (id: ThreadId) => void): void {
    let after = "";
    for (;;) {
      const rows = this.store
        .statement("SELECT id FROM threads WHERE workspace_id=? AND id>? ORDER BY id LIMIT 64")
        .all(id, after);
      if (!rows.length) return;
      for (const row of rows) {
        const threadId = ThreadId.parse(row.id);
        visit(threadId);
        after = threadId;
      }
    }
  }
}
