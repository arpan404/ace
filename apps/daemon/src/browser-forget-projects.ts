import { z } from "zod";
import { WorkspaceId } from "@ace/protocol";
import type { Store } from "./store.ts";

const Row = z.object({ workspace_id: WorkspaceId });

export interface BrowserProjectForgetPort {
  forgetProject(workspaceId: string): Promise<{ desktop: boolean }>;
}

/**
 * A removed project's browser profile goes with it: ace's Chrome profile at once, and the
 * desktop's project partition when a desktop is registered. The desktop may be closed, so each
 * removal is recorded durably and retried when a desktop registers; only the desktop's
 * confirmation clears it (as `BrowserForget` does for deleted threads).
 */
export class BrowserProjectForget {
  private store: Store;
  private browser: BrowserProjectForgetPort;
  private onError: (error: unknown) => void;
  private queue = Promise.resolve();
  private closed = false;
  constructor(store: Store, browser: BrowserProjectForgetPort, onError: (error: unknown) => void) {
    this.store = store;
    this.browser = browser;
    this.onError = onError;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS browser_forget_project_pending (
        workspace_id TEXT PRIMARY KEY
      );`),
    );
  }

  /** The project was removed: forget its profile now, and on the desktop when it can. */
  removed(workspaceId: WorkspaceId): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO browser_forget_project_pending VALUES (?)")
        .run(workspaceId),
    );
    return this.forget(workspaceId);
  }

  /**
   * The project was added back before a desktop confirmed its purge: its new profile must not be
   * purged later. What the desktop still keeps from before stays with the project.
   */
  restored(workspaceId: WorkspaceId): void {
    this.store.atomic((db) =>
      db
        .prepare("DELETE FROM browser_forget_project_pending WHERE workspace_id=?")
        .run(workspaceId),
    );
  }

  /** A desktop registered: purge every removal it has not confirmed yet. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const rows = this.store.atomic((db) =>
      db.prepare("SELECT workspace_id FROM browser_forget_project_pending LIMIT 256").all(),
    );
    return Promise.all(rows.map((raw) => this.forget(Row.parse(raw).workspace_id))).then(() => {});
  }

  close(): Promise<void> {
    this.closed = true;
    return this.queue;
  }

  private pending(workspaceId: WorkspaceId): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db
          .prepare("SELECT 1 FROM browser_forget_project_pending WHERE workspace_id=?")
          .get(workspaceId),
      ),
    );
  }

  private forget(workspaceId: WorkspaceId): Promise<void> {
    const task = this.queue
      // A project added back meanwhile keeps its profile.
      .then(() =>
        this.closed || !this.pending(workspaceId)
          ? { desktop: false }
          : this.browser.forgetProject(workspaceId),
      )
      .then(({ desktop }) => {
        if (!desktop) return;
        this.store.atomic((db) =>
          db
            .prepare("DELETE FROM browser_forget_project_pending WHERE workspace_id=?")
            .run(workspaceId),
        );
      })
      .catch(this.onError);
    this.queue = task;
    return task;
  }
}
