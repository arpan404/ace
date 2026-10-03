import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
const legacy = z.object({
  thread_id: ThreadId,
  cwd: z.string().min(1).max(4096),
  project: z.string().min(1).max(4096).nullable(),
  worktree: z.string().max(4096).nullable(),
});

/** Startup-only I/O validates old bindings, including registered paths reached through aliases. */
export function migrateWorkspaceReadiness(
  db: DatabaseSync,
  canonicalize: (path: string) => string = realpathSync,
): void {
  const page =
    db.prepare(`SELECT s.thread_id,s.cwd,w.path AS project,json_extract(t.client,'$.details.worktree') AS worktree
    FROM engine_sessions s JOIN threads t ON t.id=s.thread_id JOIN workspaces w ON w.id=t.workspace_id
    WHERE s.native_session_id IS NULL AND json_extract(t.client,'$.details.mode')='worktree'
      AND s.thread_id>? ORDER BY s.thread_id LIMIT 64`);
  const pending = db.prepare("UPDATE engine_sessions SET workspace_ready=0 WHERE thread_id=?");
  let after = "";
  for (;;) {
    const rows = page.all(after);
    for (const input of rows) {
      const row = legacy.parse(input);
      let project: string | undefined;
      try {
        if (row.project) project = canonicalize(row.project);
      } catch {
        /* Offline roots fail closed. */
      }
      if (
        project === undefined ||
        row.cwd === project ||
        row.cwd === row.project ||
        row.worktree !== row.cwd
      )
        pending.run(row.thread_id);
      after = row.thread_id;
    }
    if (rows.length < 64) return;
  }
}
