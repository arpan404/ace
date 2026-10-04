import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

const Resource = z.object({
  id: ThreadId,
  repo: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  branch: z.string().min(1).max(256),
  base_head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  cleanup_head: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable(),
  uncertain: z.number().int().min(0).max(1),
});
export type CreationResource = z.infer<typeof Resource>;
/** Durable, bounded ownership survives a crash before acceptance or during cleanup. */
export class CreationWorkspaceJournal {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_creation_resources (
      id TEXT PRIMARY KEY,repo TEXT NOT NULL,path TEXT NOT NULL,branch TEXT NOT NULL,
      base_head TEXT NOT NULL,cleanup_head TEXT,uncertain INTEGER NOT NULL DEFAULT 1
    )`),
    );
  }
  list(): CreationResource[] {
    return this.store
      .atomic((db) => db.prepare("SELECT * FROM workspace_creation_resources LIMIT 17").all())
      .map((row) => Resource.parse(row));
  }
  acquire(value: CreationResource): void {
    const row = Resource.parse(value);
    this.store.atomic((db) => {
      const count = Number(
        db.prepare("SELECT COUNT(*) AS count FROM workspace_creation_resources").get()?.count,
      );
      if (count >= 16) throw new Error("workspace_busy");
      db.prepare("INSERT INTO workspace_creation_resources VALUES (?,?,?,?,?,?,?)").run(
        row.id,
        row.repo,
        row.path,
        row.branch,
        row.base_head,
        row.cleanup_head,
        row.uncertain,
      );
    });
  }
  head(id: ThreadId, head: string): void {
    const value = Resource.shape.base_head.parse(head);
    this.store.atomic((db) =>
      db
        .prepare("UPDATE workspace_creation_resources SET cleanup_head=?,uncertain=0 WHERE id=?")
        .run(value, id),
    );
  }
  failedBeforeCreation(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE workspace_creation_resources SET uncertain=0 WHERE id=?").run(id),
    );
  }
  release(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM workspace_creation_resources WHERE id=?").run(id),
    );
  }
}
