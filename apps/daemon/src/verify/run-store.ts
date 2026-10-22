import { VerifyRun, type WorkspaceId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";
import type { LogTail } from "./log-tail.ts";
import { isSettled } from "./run-state.ts";

/** Settled runs kept per project; older ones and their logs are dropped. */
export const keptRuns = 200;

/** A temporary worktree a run made (or was about to make), journalled before it exists. */
export interface VerifyTree {
  runId: string;
  repo: string;
  path: string;
  branch: string;
}

const RunRow = z.object({ run: z.string() });
const LogRow = z.object({ text: z.string(), truncated: z.number() });
const TreeRow = z.object({
  run_id: z.string(),
  repo: z.string(),
  path: z.string(),
  branch: z.string(),
});

/**
 * Verify runs, their log tails and their worktree journal, in the daemon's event store. A row
 * that no longer parses (an older shape) is skipped, never fatal.
 */
export class VerifyRuns {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS verify_runs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        settled INTEGER NOT NULL, run TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verify_runs_workspace ON verify_runs(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS verify_logs (
        run_id TEXT PRIMARY KEY, text TEXT NOT NULL, truncated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verify_worktrees (
        run_id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL
      )`),
    );
  }

  /** Insert or replace a run; inserting one drops the project's settled runs past `keptRuns`. */
  save(run: VerifyRun): void {
    this.store.atomic((db) => {
      const existed = db.prepare("SELECT 1 FROM verify_runs WHERE id=?").get(run.id);
      db.prepare(
        "INSERT INTO verify_runs(id,workspace_id,created_at,settled,run) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET settled=excluded.settled, run=excluded.run",
      ).run(run.id, run.workspaceId, run.createdAt, Number(isSettled(run)), JSON.stringify(run));
      if (existed) return;
      const stale = db
        .prepare(
          "SELECT id FROM verify_runs WHERE workspace_id=? AND settled=1 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
        )
        .all(run.workspaceId, keptRuns);
      for (const row of stale) {
        db.prepare("DELETE FROM verify_runs WHERE id=?").run(String(row.id));
        db.prepare("DELETE FROM verify_logs WHERE run_id=?").run(String(row.id));
      }
    });
  }

  get(id: string): VerifyRun | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT run FROM verify_runs WHERE id=?").get(id),
    );
    return row ? decode(row) : undefined;
  }

  /** A project's runs, newest first. */
  list(workspaceId: WorkspaceId): VerifyRun[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT run FROM verify_runs WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC",
          )
          .all(workspaceId),
      )
      .flatMap((row) => decode(row) ?? []);
  }

  /** Every run not yet settled, oldest first. */
  live(): VerifyRun[] {
    return this.store
      .atomic((db) =>
        db.prepare("SELECT run FROM verify_runs WHERE settled=0 ORDER BY created_at, rowid").all(),
      )
      .flatMap((row) => decode(row) ?? []);
  }

  log(runId: string): LogTail {
    const row = LogRow.safeParse(
      this.store.atomic((db) =>
        db.prepare("SELECT text, truncated FROM verify_logs WHERE run_id=?").get(runId),
      ),
    );
    return row.success
      ? { text: row.data.text, truncated: row.data.truncated === 1 }
      : { text: "", truncated: false };
  }

  saveLog(runId: string, tail: LogTail): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO verify_logs(run_id,text,truncated) VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET text=excluded.text, truncated=excluded.truncated",
        )
        .run(runId, tail.text, Number(tail.truncated)),
    );
  }

  journalTree(tree: VerifyTree): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO verify_worktrees(run_id,repo,path,branch) VALUES (?,?,?,?)",
        )
        .run(tree.runId, tree.repo, tree.path, tree.branch),
    );
  }

  forgetTree(runId: string): void {
    this.store.atomic((db) => db.prepare("DELETE FROM verify_worktrees WHERE run_id=?").run(runId));
  }

  trees(): VerifyTree[] {
    return this.store
      .atomic((db) => db.prepare("SELECT run_id, repo, path, branch FROM verify_worktrees").all())
      .flatMap((row) => {
        const parsed = TreeRow.safeParse(row);
        return parsed.success
          ? [
              {
                runId: parsed.data.run_id,
                repo: parsed.data.repo,
                path: parsed.data.path,
                branch: parsed.data.branch,
              },
            ]
          : [];
      });
  }
}

function decode(row: unknown): VerifyRun | undefined {
  const parsed = RunRow.safeParse(row);
  if (!parsed.success) return undefined;
  try {
    const run = VerifyRun.safeParse(JSON.parse(parsed.data.run));
    return run.success ? run.data : undefined;
  } catch {
    return undefined;
  }
}
