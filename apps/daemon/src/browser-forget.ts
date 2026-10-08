import { z } from "zod";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import type { Store } from "./store.ts";

const Row = z.object({ thread_id: ThreadId, workspace_id: WorkspaceId });

export interface BrowserForgetPort {
  forgetThread(threadId: string, workspaceId: string): Promise<{ desktop: boolean }>;
}

/**
 * A deleted thread's browser data goes with it (ADR 0069): its open browser, the daemon's
 * persistent headless profile and the desktop's persistent partition. The desktop may be
 * closed when the thread is deleted, so each deletion is recorded durably and retried when a
 * desktop registers; only the desktop's confirmation removes it.
 */
export class BrowserForget {
  private store: Store;
  private browser: BrowserForgetPort;
  private onError: (error: unknown) => void;
  private stop: () => void;
  private running = new Map<string, Promise<void>>();
  private queue = Promise.resolve();
  private flushing: Promise<void> | undefined;
  private replayRequested = false;
  private closed = false;
  constructor(store: Store, browser: BrowserForgetPort, onError: (error: unknown) => void) {
    this.store = store;
    this.browser = browser;
    this.onError = onError;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS browser_forget_pending (
        thread_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
      );
      INSERT OR IGNORE INTO browser_forget_pending (thread_id, workspace_id)
      SELECT id, workspace_id FROM threads
      WHERE json_extract(client, '$.deletedAt') IS NOT NULL;`),
    );
    this.stop = store.subscribe((events) => {
      for (const event of events) {
        const payload = event.payload;
        if (payload.type !== "thread.client.updated" || payload.changes.deletedAt == null) continue;
        const thread = store.getThread(event.threadId);
        if (thread) this.record(thread.id, thread.workspaceId);
      }
    });
  }

  /** A desktop registered: purge every deletion it has not confirmed yet. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.replayRequested = true;
    return (this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    }));
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.replayRequested) {
      this.replayRequested = false;
      await this.replay();
    }
  }

  private async replay(): Promise<void> {
    let after = "";
    while (!this.closed) {
      const rows = this.store.atomic((db) =>
        db
          .prepare(
            "SELECT thread_id, workspace_id FROM browser_forget_pending WHERE thread_id>? ORDER BY thread_id LIMIT 256",
          )
          .all(after),
      );
      if (!rows.length) return;
      for (const raw of rows) {
        const row = Row.parse(raw);
        // Advance even after a failed purge: it stays pending for the next registration.
        after = row.thread_id;
        await this.forget(row);
      }
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.stop();
    return Promise.all([this.flushing, this.queue]).then(() => {});
  }

  private record(threadId: ThreadId, workspaceId: WorkspaceId): void {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR REPLACE INTO browser_forget_pending VALUES (?, ?)")
        .run(threadId, workspaceId),
    );
    void this.forget({ thread_id: threadId, workspace_id: workspaceId });
  }

  private forget(row: z.infer<typeof Row>): Promise<void> {
    const running = this.running.get(row.thread_id);
    if (running) return running;
    // Live deletions and replay share admission so neither can flood the bounded relay.
    const task = this.queue
      .then(() =>
        this.closed
          ? { desktop: false }
          : this.browser.forgetThread(row.thread_id, row.workspace_id),
      )
      .then(({ desktop }) => {
        if (!desktop) return;
        this.store.atomic((db) =>
          db.prepare("DELETE FROM browser_forget_pending WHERE thread_id=?").run(row.thread_id),
        );
      })
      .catch(this.onError)
      .finally(() => this.running.delete(row.thread_id));
    this.running.set(row.thread_id, task);
    this.queue = task.catch(() => {});
    return task;
  }
}
