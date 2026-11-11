import { normalizeRepositoryConfig, sameRepositoryConfig } from "@ace/forge";
import { ProjectRepositoryConfig, WorkspaceId } from "@ace/protocol";
import { ProjectError } from "./project-policy.ts";
import type { Store } from "./store.ts";

/** A saved column's choices; a value that no longer parses reads as no choices. */
function decode(value: unknown): ProjectRepositoryConfig | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = ProjectRepositoryConfig.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A project's saved repository choices, in `workspace_metadata.repositories` (ADR 0116). */
export class ProjectRepositoryConfigs {
  private store: Store;
  /** The engine's session table exists; checked until it does, then never again. */
  private sessions = false;
  constructor(store: Store) {
    this.store = store;
  }
  get(id: WorkspaceId): ProjectRepositoryConfig | undefined {
    return decode(
      this.store
        .statement("SELECT repositories FROM workspace_metadata WHERE workspace_id=?")
        .get(id)?.repositories,
    );
  }
  /**
   * The choices of the project a checkout belongs to: the project's own folder, or a thread's
   * checkout (its worktree) in that project.
   */
  forCheckout(cwd: string): ProjectRepositoryConfig | undefined {
    const id = this.projectOf(cwd);
    return id === undefined ? undefined : this.get(id);
  }
  /**
   * Replace the choices; null or empty ones clear them. With `expected` (the choices the edit
   * started from), refused with `repositories_changed` when the saved ones are others now.
   */
  set(
    id: WorkspaceId,
    input: ProjectRepositoryConfig | null,
    expected?: ProjectRepositoryConfig | null,
  ): void {
    if (expected !== undefined && !sameRepositoryConfig(this.get(id), expected))
      throw new ProjectError("repositories_changed");
    const normalized = normalizeRepositoryConfig(input && ProjectRepositoryConfig.parse(input));
    if (!normalized.ok) throw new ProjectError(normalized.error);
    const config = normalized.config;
    this.store
      .statement(
        `INSERT INTO workspace_metadata(workspace_id,repositories) VALUES (?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET repositories=excluded.repositories`,
      )
      .run(id, config ? JSON.stringify(config) : null);
  }
  private projectOf(cwd: string): WorkspaceId | undefined {
    const own = this.store
      .statement(
        `SELECT id FROM workspaces w WHERE path=? AND NOT EXISTS
        (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
        ORDER BY w.created_at,w.id LIMIT 1`,
      )
      .get(cwd);
    if (own) return WorkspaceId.parse(own.id);
    this.sessions ||= !!this.store
      .statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'")
      .get();
    if (!this.sessions) return undefined;
    const thread = this.store
      .statement(
        "SELECT t.workspace_id FROM engine_sessions s JOIN threads t ON t.id=s.thread_id WHERE s.cwd=? ORDER BY t.created_at,t.id LIMIT 1",
      )
      .get(cwd);
    return thread ? WorkspaceId.parse(thread.workspace_id) : undefined;
  }
}
