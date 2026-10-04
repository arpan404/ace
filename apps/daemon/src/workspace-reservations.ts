import { realpathSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";

/** Durable root fences outlive transient thread guards, including uncertain Git writes. */
export class WorkspaceReservations {
  private db: DatabaseSync;
  private statement: (sql: string) => StatementSync;
  constructor(
    db: DatabaseSync,
    statement: (sql: string) => StatementSync = (sql) => db.prepare(sql),
  ) {
    this.db = db;
    this.statement = statement;
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_root_reservations (
      root TEXT PRIMARY KEY, thread_id TEXT NOT NULL, command_id TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS workspace_reservation_owner ON workspace_root_reservations(thread_id);
    CREATE TABLE IF NOT EXISTS workspace_canonical_roots (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), root TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS workspace_canonical_root ON workspace_canonical_roots(root,workspace_id);`);
    for (const row of this.statement("SELECT id,path FROM workspaces").all())
      this.registerWorkspace(z.string().parse(row.id), z.string().parse(row.path));
  }
  registerWorkspace(id: string, path: string): void {
    this.statement(`INSERT INTO workspace_canonical_roots VALUES (?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET root=excluded.root`).run(id, canonicalRoot(path));
  }
  workspaceRoot(id: string, fallback: string): string {
    const row = this.statement(
      "SELECT root FROM workspace_canonical_roots WHERE workspace_id=?",
    ).get(id);
    return row ? z.string().parse(row.root) : fallback;
  }
  initializeSessions(): void {
    // Reconcile older aliases once at startup, before any provider or terminal can open.
    for (const row of this.statement("SELECT thread_id,cwd FROM engine_sessions").all()) {
      const path = z.string().parse(row.cwd);
      const root = canonicalRoot(path);
      if (root !== path)
        this.statement("UPDATE engine_sessions SET cwd=? WHERE thread_id=?").run(
          root,
          ThreadId.parse(row.thread_id),
        );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS engine_sessions_root ON engine_sessions(cwd,thread_id)",
    );
  }
  assertAvailable(root: string): void {
    if (this.statement("SELECT 1 FROM workspace_root_reservations WHERE root=?").get(root))
      throw new Error("workspace_change_in_progress");
  }
  reserved(root: string): boolean {
    return Boolean(
      this.statement("SELECT 1 FROM workspace_root_reservations WHERE root=?").get(root),
    );
  }
  threadReserved(id: ThreadId): boolean {
    const session = this.statement("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(id);
    const project = session
      ? undefined
      : this.statement(
          `SELECT root FROM workspace_canonical_roots w JOIN threads t ON t.workspace_id=w.workspace_id WHERE t.id=?`,
        ).get(id);
    const root = session?.cwd ?? project?.root;
    return typeof root === "string" && this.reserved(root);
  }
  roots(owner: ThreadId, input: readonly string[]): string[] {
    const retained = this.statement(
      "SELECT root FROM workspace_root_reservations WHERE thread_id=?",
    )
      .all(owner)
      .map((row) => z.string().parse(row.root));
    const roots = [...new Set([...input.map(canonicalRoot), ...retained])];
    if (!roots.length || roots.length > 8) throw new Error("workspace_root_limit");
    return roots;
  }
  owners(roots: readonly string[]): ThreadId[] {
    const owners = new Set<ThreadId>();
    for (const root of roots) {
      // Scope by indexed root/workspace first. No transcript or event history is read.
      const sessions = this.statement(
        "SELECT thread_id FROM engine_sessions WHERE cwd=? LIMIT 257",
      ).all(root);
      const local =
        this.statement(`SELECT t.id AS thread_id FROM workspace_canonical_roots w JOIN threads t ON t.workspace_id=w.workspace_id
        WHERE w.root=? AND NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.thread_id=t.id) LIMIT 257`).all(
          root,
        );
      for (const row of [...sessions, ...local]) owners.add(ThreadId.parse(row.thread_id));
      if (owners.size > 256) throw new Error("workspace_owner_limit");
    }
    return [...owners];
  }
  reserve(owner: ThreadId, commandId: string, roots: readonly string[]): void {
    for (const root of roots) {
      const row = this.statement(
        "SELECT thread_id FROM workspace_root_reservations WHERE root=?",
      ).get(root);
      if (row && row.thread_id !== owner) throw new Error("workspace_change_in_progress");
    }
    for (const root of roots)
      this.statement(`INSERT INTO workspace_root_reservations VALUES (?,?,?)
      ON CONFLICT(root) DO UPDATE SET command_id=excluded.command_id`).run(root, owner, commandId);
  }
  release(commandId: string): void {
    this.statement("DELETE FROM workspace_root_reservations WHERE command_id=?").run(commandId);
  }
}

function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
