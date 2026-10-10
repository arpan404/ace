import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { ThreadId, type ForgeRepository, type ForgePrRef, type Event } from "@ace/protocol";
import { createsPullRequest, createdPullRequest } from "./pr-create-command.ts";
import type { Store } from "./store.ts";

interface WorkspacePrLinks {
  root(id: ThreadId): string;
  forge: {
    repository(cwd: string): Promise<ForgeRepository>;
    link(id: ThreadId, cwd: string, ref: ForgePrRef, allowed: () => boolean): Promise<unknown>;
  };
}
const Pending = z.object({
  rowid: z.number().int(),
  threadId: ThreadId,
  cwd: z.string(),
  streamId: z.string().nullable(),
});

/** Durable observation of completed commands, independent of provider-native frame shapes. */
export class PullRequestAutoLink {
  private readonly store: Store;
  private readonly workspace: WorkspacePrLinks;
  private readonly onError: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  private flight: Promise<void> | undefined;
  private closed = false;
  private revision = 0;
  private handledRevision = 0;
  constructor(store: Store, workspace: WorkspacePrLinks, onError: (error: unknown) => void) {
    this.store = store;
    this.workspace = workspace;
    this.onError = onError;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS thread_pr_creations (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL, cwd TEXT NOT NULL, stream_id TEXT,
        done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS thread_pr_creations_pending ON thread_pr_creations(done) WHERE done=0;
    `),
    );
    this.unsubscribe = store.subscribe((events) => this.observe(events));
    this.wake();
  }
  private observe(events: Event[]): void {
    if (this.closed) return;
    let added = false;
    for (const event of events) {
      const payload = event.payload;
      if (payload.type !== "item.created" && payload.type !== "item.updated") continue;
      const item = payload.item;
      if (
        item.type !== "tool_call" ||
        !item.complete ||
        (item.call.status !== "succeeded" && item.call.status !== "failed")
      )
        continue;
      const detail = item.call.detail;
      if (
        detail.kind !== "shell" ||
        !createsPullRequest(detail.rawCommand ?? detail.command) ||
        !detail.output
      )
        continue;
      try {
        const result = this.store
          .statement(`
          INSERT OR IGNORE INTO thread_pr_creations(thread_id,item_id,cwd,stream_id)
          VALUES (?,?,?,?)
        `)
          .run(
            event.threadId,
            item.id,
            this.workspace.root(event.threadId),
            detail.output.streamId,
          );
        added ||= result.changes > 0;
      } catch (error) {
        this.onError(error);
      }
    }
    if (added) this.wake();
  }
  private wake(): void {
    this.revision++;
    if (this.flight || this.closed) return;
    this.flight = Promise.resolve()
      .then(() => this.run())
      .catch(this.onError)
      .finally(() => {
        this.flight = undefined;
        if (!this.closed && this.handledRevision !== this.revision) this.wake();
      });
  }
  private async run(): Promise<void> {
    let after = 0;
    let revision = this.revision;
    this.handledRevision = revision;
    while (!this.closed) {
      const row = this.store
        .statement(`
        SELECT rowid,thread_id AS threadId,cwd,stream_id AS streamId
        FROM thread_pr_creations WHERE done=0 AND rowid>? ORDER BY rowid LIMIT 1
      `)
        .get(after);
      if (!row) {
        if (revision === this.revision) return;
        revision = this.revision;
        this.handledRevision = revision;
        after = 0;
        continue;
      }
      const pending = Pending.parse(row);
      after = pending.rowid;
      const allowed = () => {
        if (this.closed || this.store.getThread(pending.threadId)?.deletedAt !== undefined)
          return false;
        try {
          return this.workspace.root(pending.threadId) === pending.cwd;
        } catch {
          return false;
        }
      };
      try {
        if (allowed()) {
          const repository = await this.workspace.forge.repository(pending.cwd);
          const ref = await this.readCreatedPr(pending, repository);
          if (ref && allowed())
            await this.workspace.forge.link(pending.threadId, pending.cwd, ref, allowed);
        }
        if (!this.closed)
          this.store
            .statement("UPDATE thread_pr_creations SET done=1,stream_id=NULL WHERE rowid=?")
            .run(pending.rowid);
      } catch (error) {
        // Leave the durable observation pending for the next wake or restart.
        if (!this.closed) this.onError(error);
      }
    }
  }
  private async readCreatedPr(
    pending: z.infer<typeof Pending>,
    repository: ForgeRepository,
  ): Promise<ForgePrRef | undefined> {
    if (!pending.streamId) return undefined;
    const info = this.store.outputInfo(pending.streamId);
    if (info.threadId !== pending.threadId) return undefined;
    const decoder = new TextDecoder();
    let offset = 0;
    let line = "";
    let oversized = false;
    while (!this.closed && offset < info.size) {
      const page = this.store.readOutputBytes(
        pending.streamId,
        offset,
        Math.min(64 * 1024, info.size - offset),
      );
      if (page.nextOffset <= offset) break;
      offset = page.nextOffset;
      const text = decoder.decode(page.bytes, { stream: offset < info.size });
      for (const char of text) {
        if (char === "\n") {
          const ref = !oversized ? createdPullRequest(line, repository) : undefined;
          if (ref) return ref;
          line = "";
          oversized = false;
        } else if (line.length < 4096) line += char;
        else oversized = true;
      }
      await setImmediate();
    }
    return !oversized ? createdPullRequest(line, repository) : undefined;
  }
  async drained(): Promise<void> {
    while (this.flight) await this.flight;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    await this.flight;
  }
}
