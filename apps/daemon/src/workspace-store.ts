import {
  ThreadId,
  WorkspaceFileChange,
  WorkspaceId,
  type EventPayload,
  type ProjectKind,
  type Thread,
} from "@ace/protocol";
import type { StatementSync } from "node:sqlite";
import { decodeProjectRow } from "./project-storage.ts";
import type { FrozenThread } from "./thread-cache.ts";
import type { WorkspaceReservations } from "./workspace-reservations.ts";
import { executionWorkspace } from "./workspace-root.ts";

/** A workspace as a client reads it: its folder, its name and the project details it chose. */
export interface WorkspaceDetails {
  path: string;
  name: string;
  icon?: string | null;
  defaultIcon?: string | null;
  kind?: ProjectKind;
}

interface WorkspaceSource {
  statement(sql: string): StatementSync;
  /** One write transaction on this store's connection. */
  atomic<T>(run: () => T): T;
  /** A transaction on this store's terms: live writes flushed, nested calls joined. */
  transaction<T>(run: () => T): T;
  nextId(): string;
  /** The store's event writer, so a change notifies clients in the same transaction. */
  appendEvents(threadId: ThreadId, payloads: EventPayload[]): void;
  /** The caller's own copy of a thread row. */
  getThread(id: ThreadId): Thread | undefined;
  /** The shared, frozen thread a check only reads fields from. */
  readThread(id: ThreadId): FrozenThread | undefined;
  reservations: WorkspaceReservations;
}

/**
 * Workspaces as storage keeps them: the project row clients read, the folder a thread runs in
 * (its provider session's root, else its project's), workspace creation, and fan-out of
 * workspace file changes to the threads they concern. Thread rows themselves belong to the
 * thread cache; project edits to `project-storage.ts`.
 */
export class WorkspaceStore {
  private readonly source: WorkspaceSource;
  /** This build's schema has `engine_sessions`; older databases are asked once. */
  private sessionsKnown = false;
  constructor(source: WorkspaceSource) {
    this.source = source;
  }
  getWorkspace(id: WorkspaceId): WorkspaceDetails | undefined {
    const row = this.source
      .statement(
        "SELECT w.id,w.path,w.name,m.icon,m.default_icon AS defaultIcon,m.kind FROM workspaces w LEFT JOIN workspace_metadata m ON m.workspace_id=w.id WHERE w.id=?",
      )
      .get(id);
    if (!row) return undefined;
    const project = decodeProjectRow(row);
    return {
      path: project.path,
      name: project.name,
      ...(project.icon === undefined ? {} : { icon: project.icon }),
      ...(project.defaultIcon === undefined ? {} : { defaultIcon: project.defaultIcon }),
      ...(project.kind ? { kind: project.kind } : {}),
    };
  }
  executionWorkspace(id: ThreadId) {
    const thread = this.source.getThread(id);
    if (!thread) throw new Error("thread_not_found");
    if (!this.sessionsKnown)
      this.sessionsKnown = Boolean(
        this.source
          .statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'")
          .get(),
      );
    const session = this.sessionsKnown
      ? this.source.statement("SELECT * FROM engine_sessions WHERE thread_id=?").get(id)
      : undefined;
    const binding = executionWorkspace(
      thread,
      session,
      session === undefined ? this.getWorkspacePath(thread.workspaceId) : undefined,
    );
    const root =
      session === undefined
        ? this.source.reservations.workspaceRoot(thread.workspaceId, binding.path)
        : binding.path;
    this.source.reservations.assertAvailable(root);
    return binding;
  }
  completeWorkspacePreparation(id: ThreadId, expectedPath: string, path: string): boolean {
    const thread = this.source.readThread(id);
    if (!thread || thread.deletedAt !== undefined) return false;
    this.source.reservations.assertAvailable(expectedPath);
    this.source.reservations.assertAvailable(path);
    const result = this.source
      .statement(
        "UPDATE engine_sessions SET cwd=?,workspace_ready=1 WHERE thread_id=? AND cwd=? AND workspace_ready=0",
      )
      .run(path, id, expectedPath);
    return result.changes === 1;
  }
  /** Registers a folder as a workspace, or returns the one already registered at `path`. */
  createWorkspace(path: string, name: string, at: number): WorkspaceId {
    return this.source.atomic(() => {
      const existing = this.source.statement("SELECT id FROM workspaces WHERE path = ?").get(path);
      const id = WorkspaceId.parse(existing?.id ?? this.source.nextId());
      if (!existing)
        this.source.statement("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(id, path, name, at);
      this.source.reservations.registerWorkspace(id, path);
      return id;
    });
  }
  getWorkspacePath(id: WorkspaceId): string | undefined {
    const row = this.source.statement("SELECT path FROM workspaces WHERE id = ?").get(id);
    return typeof row?.path === "string" ? row.path : undefined;
  }
  /**
   * Indexed fan-out to the current threads running in `root`: those whose session runs there,
   * and those not yet started whose project is that root. Threads in the project's other
   * checkouts never hear about it. Never scans event or transcript history.
   */
  recordWorkspaceFileChange(
    workspaceId: WorkspaceId,
    root: string,
    input: WorkspaceFileChange,
  ): void {
    const change = WorkspaceFileChange.parse(input);
    const sessions = Boolean(
      this.source
        .statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'")
        .get(),
    );
    const projectRoot = this.source.reservations.workspaceRoot(workspaceId, "");
    const scope = sessions
      ? `(t.id IN (SELECT thread_id FROM engine_sessions WHERE cwd=?) OR (? AND NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.thread_id=t.id)))`
      : `(? IS NOT NULL AND ?)`;
    let after = "";
    for (;;) {
      const rows = this.source
        .statement(
          `SELECT t.id FROM threads t WHERE t.workspace_id=? AND t.archived_at IS NULL AND json_extract(t.client,'$.deletedAt') IS NULL AND ${scope} AND t.id>? ORDER BY t.id LIMIT 64`,
        )
        .all(workspaceId, root, projectRoot === root ? 1 : 0, after);
      if (!rows.length) return;
      this.source.transaction(() => {
        for (const row of rows) {
          const id = ThreadId.parse(row.id);
          this.source.appendEvents(id, [{ type: "workspace.files_changed", workspaceId, change }]);
          after = id;
        }
      });
    }
  }
}
