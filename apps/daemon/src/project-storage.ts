import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  Project,
  ProjectBadgeStyle,
  ProjectDefaults,
  ProjectNote,
  ThreadId,
  type WorkspaceId,
  type WorkspaceChanged,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { ProjectError } from "./project-policy.ts";

const recentRow = z.object({ path: Project.shape.path, opened_at: z.number().nonnegative() });
const folderRow = z.object({ opened_at: z.number().nonnegative().nullable() });

export function migrateProjects(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_metadata (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), icon TEXT, default_icon TEXT
  ); CREATE TABLE IF NOT EXISTS workspace_unregistered (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), removed_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS workspace_recent (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), opened_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS threads_project_order ON threads(workspace_id, id);
  CREATE INDEX IF NOT EXISTS workspace_recent_order ON workspace_recent(opened_at DESC, workspace_id);`);
  if (
    !db
      .prepare("PRAGMA table_info(workspace_metadata)")
      .all()
      .some((column) => column.name === "default_icon")
  )
    db.exec("ALTER TABLE workspace_metadata ADD COLUMN default_icon TEXT");
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(workspace_metadata)")
      .all()
      .map((column) => column.name),
  );
  if (!columns.has("badge")) db.exec("ALTER TABLE workspace_metadata ADD COLUMN badge TEXT");
  if (!columns.has("defaults")) db.exec("ALTER TABLE workspace_metadata ADD COLUMN defaults TEXT");
  if (!columns.has("notes")) db.exec("ALTER TABLE workspace_metadata ADD COLUMN notes TEXT");
  if (!columns.has("kind")) db.exec("ALTER TABLE workspace_metadata ADD COLUMN kind TEXT");
}

/** Every project column a `Project` decodes from (`decodeProjectRow`), with `w` the workspace. */
export const projectSelect =
  "SELECT w.id,w.name,w.path,m.icon,m.default_icon AS defaultIcon,m.badge,m.defaults,m.notes,m.kind FROM workspaces w LEFT JOIN workspace_metadata m ON m.workspace_id=w.id";

/** What a project edit changes besides its name; each omitted field keeps the saved value. */
export interface ProjectEdit {
  icon?: string | null | undefined;
  defaultIcon?: string | null | undefined;
  badge?: ProjectBadgeStyle | null | undefined;
  defaults?: ProjectDefaults | null | undefined;
  /** The whole resolved list; see `project-notes.ts` for how edits resolve. */
  notes?: ProjectNote[] | undefined;
}
/** A JSON column's text, or NULL for a cleared value. */
const json = (value: object | null | undefined) =>
  value === undefined || value === null ? null : JSON.stringify(value);

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
          `${projectSelect} WHERE w.id=? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=w.id)`,
        )
        .get(id);
      if (!row) throw new ProjectError("workspace_not_found");
      return decodeProjectRow(row);
    });
  }
  register(path: string, name: string, icon?: string | null, defaultIcon?: string | null): Project {
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
      if (icon !== undefined || defaultIcon !== undefined)
        this.saveMetadata(db, id, { icon, defaultIcon });
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
    if (!added && (icon !== undefined || defaultIcon !== undefined))
      return this.update(workspace.id, workspace.name, { icon, defaultIcon });
    return workspace;
  }
  /** Register a chat's folder as a hidden `chat` project (ADR 0099). */
  registerChat(path: string, name: string): Project {
    const workspace = this.store.atomic((db) => {
      const id = this.store.createWorkspace(path, name, this.now());
      db.prepare(
        "INSERT INTO workspace_metadata(workspace_id,kind) VALUES (?,'chat') ON CONFLICT(workspace_id) DO UPDATE SET kind='chat'",
      ).run(id);
      return this.get(id);
    });
    this.emit({ type: "workspace.changed", change: "added", workspaceId: workspace.id, workspace });
    return workspace;
  }
  /** Unregister a project without touching its threads; a chat's last thread already went. */
  forget(id: WorkspaceId): void {
    this.store
      .statement(
        "INSERT INTO workspace_unregistered VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET removed_at=excluded.removed_at",
      )
      .run(id, this.now());
    this.emit({ type: "workspace.changed", change: "removed", workspaceId: id });
  }
  recent(limit: number): Project[] {
    return this.store.atomic((db) =>
      db
        .prepare(`${projectSelect} JOIN workspace_recent r ON w.id=r.workspace_id
      WHERE NOT EXISTS (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
      AND m.kind IS NULL ORDER BY r.opened_at DESC,w.id LIMIT ?`)
        .all(limit)
        .map(decodeProjectRow),
    );
  }
  page(after: WorkspaceId | undefined, limit: number) {
    const rows = this.store.atomic((db) =>
      db
        .prepare(`${projectSelect} WHERE w.id>? AND NOT EXISTS
      (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
      ORDER BY w.id LIMIT ?`)
        .all(after ?? "", limit + 1)
        .map(decodeProjectRow),
    );
    const projects = rows.slice(0, limit);
    return { projects, next: rows.length > limit ? (projects.at(-1)?.id ?? null) : null };
  }
  recentHints(limit: number) {
    return this.store.atomic((db) =>
      db
        .prepare(`SELECT w.path,r.opened_at FROM workspace_recent r
      JOIN workspaces w ON w.id=r.workspace_id
      LEFT JOIN workspace_metadata m ON m.workspace_id=w.id WHERE NOT EXISTS
      (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id) AND m.kind IS NULL
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
  private saveMetadata(db: DatabaseSync, id: WorkspaceId, edit: ProjectEdit): void {
    db.prepare(
      `INSERT INTO workspace_metadata(workspace_id,icon,default_icon,badge,defaults,notes) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
      icon=CASE WHEN ? THEN excluded.icon ELSE workspace_metadata.icon END,
      default_icon=CASE WHEN ? THEN excluded.default_icon ELSE workspace_metadata.default_icon END,
      badge=CASE WHEN ? THEN excluded.badge ELSE workspace_metadata.badge END,
      defaults=CASE WHEN ? THEN excluded.defaults ELSE workspace_metadata.defaults END,
      notes=CASE WHEN ? THEN excluded.notes ELSE workspace_metadata.notes END`,
    ).run(
      id,
      edit.icon ?? null,
      edit.defaultIcon ?? null,
      json(edit.badge),
      json(edit.defaults),
      edit.notes?.length ? JSON.stringify(edit.notes) : null,
      Number(edit.icon !== undefined),
      Number(edit.defaultIcon !== undefined),
      Number(edit.badge !== undefined),
      Number(edit.defaults !== undefined),
      Number(edit.notes !== undefined),
    );
  }
  /** Replace the notes with `change(current)`; undefined leaves them (and every device) alone. */
  editNotes(
    id: WorkspaceId,
    change: (notes: readonly ProjectNote[]) => ProjectNote[] | undefined,
  ): Project | undefined {
    const project = this.get(id);
    const notes = change(project.notes ?? []);
    return notes ? this.update(id, project.name, { notes }) : undefined;
  }
  rename(id: WorkspaceId, name: string): Project {
    return this.update(id, name, {}, "renamed");
  }
  update(
    id: WorkspaceId,
    name: string,
    edit: ProjectEdit,
    change: "updated" | "renamed" = "updated",
  ): Project {
    const { icon, defaultIcon } = edit;
    const workspace = this.store.atomic((db) => {
      this.get(id);
      db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(name, id);
      if (Object.values(edit).some((value) => value !== undefined)) this.saveMetadata(db, id, edit);
      this.forThreads(id, (threadId) => {
        const thread = this.store.getThread(threadId);
        const details = thread?.details;
        if (details?.workspace)
          this.store.appendEvents(
            threadId,
            [
              {
                type: "thread.client.updated",
                changes: {
                  details: {
                    ...details,
                    workspace: {
                      ...details.workspace,
                      name,
                      ...(icon === undefined ? {} : { icon }),
                      ...(defaultIcon === undefined ? {} : { defaultIcon }),
                    },
                  },
                },
              },
            ],
            this.now(),
          );
      });
      return this.get(id);
    });
    this.emit({ type: "workspace.changed", change, workspaceId: id, workspace });
    return workspace;
  }
  /**
   * The project's threads that removal deletes. Refuses while one still runs, unless the person
   * chose to stop them, and while a worktree change holds the project's folder.
   */
  threadsToDelete(
    id: WorkspaceId,
    stopRunning: boolean,
    hasOwnedWork: (id: ThreadId) => boolean,
  ): ThreadId[] {
    const workspace = this.get(id);
    this.store.workspaceReservations.assertAvailable(
      this.store.workspaceReservations.workspaceRoot(id, workspace.path),
    );
    const threads: ThreadId[] = [];
    this.forThreads(id, (threadId) => {
      const thread = this.store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) return;
      if (!stopRunning && running(thread.status.state, hasOwnedWork(threadId)))
        throw new ProjectError("workspace_threads_running");
      threads.push(threadId);
    });
    return threads;
  }
  /**
   * Stop listing the project and delete what is left of its threads, so none of them keeps it
   * on screen. Its threads were already deleted through the thread lifecycle where it runs; one
   * that started since is refused while it runs unless the person chose to stop running ones.
   */
  remove(id: WorkspaceId, stopRunning: boolean, hasOwnedWork: (id: ThreadId) => boolean): void {
    this.store.atomic((db) => {
      const workspace = this.get(id);
      this.store.workspaceReservations.assertAvailable(
        this.store.workspaceReservations.workspaceRoot(id, workspace.path),
      );
      this.forThreads(id, (threadId) => {
        const thread = this.store.getThread(threadId);
        if (!thread || thread.deletedAt !== undefined) return;
        if (!stopRunning && running(thread.status.state, hasOwnedWork(threadId)))
          throw new ProjectError("workspace_threads_running");
        this.store.appendEvents(
          threadId,
          [
            {
              type: "thread.client.updated",
              changes: { deletedAt: this.now(), autoSettleAt: null },
            },
          ],
          this.now(),
        );
      });
      db.prepare(
        "INSERT INTO workspace_unregistered VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET removed_at=excluded.removed_at",
      ).run(id, this.now());
    });
    this.emit({ type: "workspace.changed", change: "removed", workspaceId: id });
  }
  /**
   * Delete threads left in removed projects, which removal once kept (archived). They kept a
   * removed project in the task list's project filter with nothing to manage it from. One that
   * still runs is left until a later start finds it settled. Returns the next page's cursor.
   */
  deleteLeftoverThreads(
    after: string,
    hasOwnedWork: (id: ThreadId) => boolean,
  ): string | undefined {
    const rows = this.store
      .statement(
        `SELECT t.id FROM threads t JOIN workspace_unregistered u ON u.workspace_id=t.workspace_id
        LEFT JOIN workspace_metadata m ON m.workspace_id=t.workspace_id
        WHERE t.id>? AND coalesce(m.kind,'')<>'chat'
        AND json_extract(t.client,'$.deletedAt') IS NULL ORDER BY t.id LIMIT 64`,
      )
      .all(after)
      .map((row) => ThreadId.parse(row.id));
    this.store.atomic(() => {
      for (const threadId of rows) {
        const thread = this.store.getThread(threadId);
        if (!thread || thread.deletedAt !== undefined) continue;
        if (running(thread.status.state, hasOwnedWork(threadId))) continue;
        this.store.appendEvents(
          threadId,
          [
            {
              type: "thread.client.updated",
              changes: { deletedAt: this.now(), autoSettleAt: null },
            },
          ],
          this.now(),
        );
      }
    });
    return rows.length === 64 ? rows[63] : undefined;
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

/** A thread still working, or one whose terminals or previews still run. */
const running = (state: string, ownsWork: boolean) =>
  ownsWork || !["new", "done", "failed"].includes(state);

const storedRow = Project.extend({
  kind: Project.shape.kind.nullable().catch(null),
  badge: z.unknown().optional(),
  defaults: z.unknown().optional(),
  notes: z.unknown().optional(),
});

/** A saved JSON column, or undefined when it is empty or no longer reads as `schema`. */
function stored<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Projects omit unset optional fields rather than adding null fields to their wire shape. */
export function decodeProjectRow(row: unknown): Project {
  const { badge, defaults, notes, kind, ...project } = storedRow.parse(row);
  if (project.icon === null) delete project.icon;
  if (project.defaultIcon === null) delete project.defaultIcon;
  const style = stored(ProjectBadgeStyle, badge);
  const preferences = stored(ProjectDefaults, defaults);
  const facts = stored(Project.shape.notes, notes);
  return {
    ...project,
    ...(kind ? { kind } : {}),
    ...(style ? { badge: style } : {}),
    ...(preferences ? { defaults: preferences } : {}),
    ...(facts?.length ? { notes: facts } : {}),
  };
}
