import { settleDecision, settlePolicy } from "@ace/projection";
import type { SettingsService } from "@ace/settings";
import { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

export type OrganizerSchedule = (delay: number, work: () => void) => () => void;
export const organizerSchedule: OrganizerSchedule = (delay, work) => {
  const timer = setTimeout(work, delay);
  timer.unref();
  return () => clearTimeout(timer);
};
/** Disk queue and indexed deadlines keep memory independent of retained thread history. */
export class ThreadOrganizer {
  private store: Store;
  private settings: SettingsService | undefined;
  private now: () => number;
  private schedule: OrganizerSchedule;
  private cancel: (() => void) | undefined;
  private unsubscribe: () => void;
  private stopSettings: (() => void) | undefined;
  private stopChanges: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private retry = false;
  constructor(
    store: Store,
    settings: SettingsService | undefined,
    now: () => number,
    schedule = organizerSchedule,
  ) {
    this.store = store;
    this.settings = settings;
    this.now = now;
    this.schedule = schedule;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS thread_settle_due(thread_id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS thread_settle_deadlines ON thread_settle_due(due);
      CREATE TABLE IF NOT EXISTS thread_organizer_dirty(thread_id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO thread_organizer_dirty SELECT id FROM threads;`),
    );
    this.unsubscribe = store.subscribe((events) => {
      for (const event of events) {
        const p = event.payload;
        if (p.type === "thread.updated" && p.status) {
          store.appendEvents(
            event.threadId,
            [{ type: "thread.client.updated", changes: { activityAt: event.at } }],
            event.at,
          );
        }
        if (
          p.type === "thread.created" ||
          p.type === "thread.updated" ||
          (p.type === "thread.client.updated" &&
            (p.changes.activityAt !== undefined ||
              p.changes.details !== undefined ||
              p.changes.deletedAt !== undefined ||
              p.changes.pinned !== undefined ||
              p.changes.snoozedUntil !== undefined))
        ) {
          store.atomic((db) =>
            db
              .prepare("INSERT OR IGNORE INTO thread_organizer_dirty VALUES (?)")
              .run(event.threadId),
          );
          this.arm(0);
        }
      }
    });
    if (settings) {
      this.stopChanges = settings.onChange((layer, keys) => {
        if (
          !keys.some((key) =>
            ["threads.autoSettleAfter", "threads.settleOnMerge", "threads.settleOnClose"].includes(
              key,
            ),
          )
        )
          return;
        store.atomic((db) => {
          if (layer.kind === "global")
            db.exec("INSERT OR IGNORE INTO thread_organizer_dirty SELECT id FROM threads");
          else if (layer.kind === "thread")
            db.prepare(
              "INSERT OR IGNORE INTO thread_organizer_dirty SELECT id FROM threads WHERE id=?",
            ).run(layer.thread);
          else
            db.prepare(
              "INSERT OR IGNORE INTO thread_organizer_dirty SELECT threads.id FROM threads JOIN workspaces ON workspace_id=workspaces.id WHERE workspaces.path=?",
            ).run(layer.workspace);
        });
        this.arm(0);
      });
      void settings
        .subscribe(
          {
            keys: ["threads.autoSettleAfter", "threads.settleOnMerge", "threads.settleOnClose"],
            scope: {},
          },
          () => {
            store.atomic((db) =>
              db.exec("INSERT OR IGNORE INTO thread_organizer_dirty SELECT id FROM threads"),
            );
            this.arm(0);
          },
        )
        .then((stop) => {
          if (this.stopped) stop();
          else this.stopSettings = stop;
        })
        .catch(() => {});
    }
    this.arm(0);
  }
  private arm(delay: number): void {
    if (this.stopped || this.pending) return;
    this.cancel?.();
    this.cancel = this.schedule(delay, () => {
      void this.sweep().catch(() => {});
    });
  }
  private async refresh(id: ThreadId): Promise<void> {
    const thread = this.store.getThread(id);
    if (!thread) return;
    let policy = settlePolicy([]);
    if (this.settings) {
      const path = this.store.getWorkspacePath(thread.workspaceId);
      const scope = { thread: thread.id, ...(path ? { workspace: path } : {}) };
      const data = await this.settings.read({
        keys: ["threads.autoSettleAfter", "threads.settleOnMerge", "threads.settleOnClose"],
        scope,
      });
      policy = settlePolicy(data.entries);
    }
    if (this.stopped) return;
    await this.store.writable();
    this.store.atomic((db) => {
      const current = this.store.getThread(id);
      if (!current) return;
      const changes = settleDecision(current, policy, this.now());
      if (
        Object.entries(changes).some(
          ([key, value]) => (Reflect.get(current, key) ?? null) !== value,
        )
      )
        this.store.appendEvents(id, [{ type: "thread.client.updated", changes }], this.now());
      db.prepare("DELETE FROM thread_settle_due WHERE thread_id=?").run(id);
      const deadline = Math.min(
        typeof changes.autoSettleAt === "number" ? changes.autoSettleAt : Infinity,
        current.deletedAt === undefined &&
          current.snoozedUntil !== undefined &&
          current.snoozedUntil > this.now()
          ? current.snoozedUntil
          : Infinity,
      );
      if (Number.isFinite(deadline))
        db.prepare("INSERT INTO thread_settle_due VALUES (?,?)").run(id, deadline);
    });
  }
  /** Public clock boundary, also used by the one owned timer. */
  sweep(): Promise<void> {
    if (this.pending) return this.pending;
    this.cancel?.();
    this.pending = (async () => {
      await this.store.writable();
      const ids = this.store.atomic((db) => {
        db.prepare(
          "INSERT OR IGNORE INTO thread_organizer_dirty SELECT thread_id FROM thread_settle_due WHERE due<=? ORDER BY due LIMIT 64",
        ).run(this.now());
        return db
          .prepare("SELECT thread_id FROM thread_organizer_dirty LIMIT 64")
          .all()
          .map((row) => ThreadId.parse(row.thread_id));
      });
      for (const id of ids) {
        await this.store.writable();
        if (this.stopped) return;
        // Remove before reading. An event arriving during the asynchronous read requeues it.
        this.store.atomic((db) =>
          db.prepare("DELETE FROM thread_organizer_dirty WHERE thread_id=?").run(id),
        );
        try {
          await this.refresh(id);
        } catch (error) {
          this.retry = true;
          this.store.atomic((db) =>
            db.prepare("INSERT OR IGNORE INTO thread_organizer_dirty VALUES (?)").run(id),
          );
          throw error;
        }
      }
    })().finally(async () => {
      try {
      await this.store.writable();
      this.pending = undefined;
      if (!this.stopped) {
        const dirty = this.store.atomic((db) =>
          Boolean(db.prepare("SELECT 1 FROM thread_organizer_dirty LIMIT 1").get()),
        );
        const due = this.store.atomic(
          (db) => db.prepare("SELECT MIN(due) AS due FROM thread_settle_due").get()?.due,
        );
        const delay =
          typeof due === "number" ? Math.min(60_000, Math.max(0, due - this.now())) : 60_000;
        this.arm(this.retry ? 60_000 : dirty ? 0 : delay);
        this.retry = false;
      }
      } catch {
        this.pending = undefined;
        this.retry = false;
        this.arm(1000);
      }
    });
    return this.pending;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    this.unsubscribe();
    this.stopSettings?.();
    this.stopChanges?.();
    await this.pending;
  }
}
