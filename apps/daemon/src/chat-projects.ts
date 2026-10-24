import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WorkspaceId, type Event, type Project } from "@ace/protocol";
import type { ProjectStorage } from "./project-storage.ts";
import type { Store } from "./store.ts";

/** A chat project with no thread yet may still be starting one; it is kept this long. */
export const emptyChatGraceMs = 60 * 60_000;

const chatRow = z.object({
  id: WorkspaceId,
  path: z.string(),
  created_at: z.number(),
  total: z.number().int(),
  kept: z.number().int(),
});
export type ChatRow = z.infer<typeof chatRow>;

/**
 * Whether a chat project can go: none of its threads are kept. One with no thread at all (it
 * never got one, or its thread moved to a project) goes once the grace period ends.
 */
export function chatDisposable(row: ChatRow, now: number): boolean {
  if (row.kept > 0) return false;
  return row.total > 0 || now - row.created_at >= emptyChatGraceMs;
}

/** Only a direct child of the chats root is ever removed. */
export function chatFolderOwned(root: string, path: string): boolean {
  return dirname(path) === root && path !== root;
}

/**
 * Chats started with no project (ADR 0099). Each gets a fresh empty folder under `root`,
 * registered as a hidden `chat` project. When a chat's threads are all deleted its project is
 * unregistered and its folder removed; one whose thread moved to a project goes at a later
 * start.
 */
export class ChatProjects {
  private store: Store;
  private catalog: ProjectStorage;
  private root: string;
  private now: () => number;
  private newId: () => string;
  private sweeping: Promise<void> | undefined;
  private again = false;
  private closed = false;
  private stop: () => void;
  constructor(
    store: Store,
    catalog: ProjectStorage,
    root: string,
    now: () => number,
    newId: () => string,
  ) {
    this.store = store;
    this.catalog = catalog;
    this.root = root;
    this.now = now;
    this.newId = newId;
    this.stop = store.subscribe((events) => {
      // After the committing transaction, never inside it.
      if (events.some(endsChatThread)) void Promise.resolve().then(() => this.sweep());
    });
  }
  async create(): Promise<Project> {
    const path = join(this.root, this.newId());
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      return this.catalog.registerChat(path, "Chat");
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
  /** Remove every chat project that can go. Overlapping calls run one more pass. */
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.again = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }
  private async pass(): Promise<void> {
    let after = "";
    while (!this.closed) {
      const rows = this.store
        .statement(
          `SELECT w.id,w.path,w.created_at,
          (SELECT COUNT(*) FROM threads t WHERE t.workspace_id=w.id) AS total,
          (SELECT COUNT(*) FROM threads t WHERE t.workspace_id=w.id
            AND json_extract(t.client,'$.deletedAt') IS NULL) AS kept
          FROM workspaces w JOIN workspace_metadata m ON m.workspace_id=w.id
          WHERE m.kind='chat' AND w.id>? AND NOT EXISTS
          (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
          ORDER BY w.id LIMIT 64`,
        )
        .all(after)
        .map((row) => chatRow.parse(row));
      if (!rows.length) return;
      for (const row of rows) {
        after = row.id;
        if (this.closed || !chatDisposable(row, this.now())) continue;
        this.catalog.forget(row.id);
        if (chatFolderOwned(this.root, row.path))
          await rm(row.path, { recursive: true, force: true });
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await this.sweeping;
  }
}

/**
 * A thread was deleted: its chat may now be empty. A move to a project waits for the next
 * start, so Undo can still move the thread back into its chat's folder.
 */
function endsChatThread(event: Event): boolean {
  const payload = event.payload;
  return payload.type === "thread.client.updated" && payload.changes.deletedAt !== undefined;
}
