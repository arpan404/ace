import type { StorageService } from "./service.ts";
import type { StorageOwner } from "./types.ts";

export type StorageSchedule = (delay: number, work: () => void) => () => void;
export const storageSchedule: StorageSchedule = (delay, work) => {
  const timer = setTimeout(work, delay);
  timer.unref();
  return () => clearTimeout(timer);
};
/** One daily host maintenance hook with a durable deadline and no agent/CLI invocation. */
export class ScheduledStorageCleanup {
  private owner: StorageOwner;
  private service: StorageService;
  private schedule: StorageSchedule;
  private cancel: (() => void) | undefined;
  private release: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private enabled = false;
  private closed = false;
  constructor(owner: StorageOwner, service: StorageService, schedule: StorageSchedule) {
    this.owner = owner;
    this.service = service;
    this.schedule = schedule;
    owner.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS storage_schedule(id INTEGER PRIMARY KEY CHECK(id=1),due INTEGER NOT NULL)",
      ),
    );
  }
  async start(): Promise<void> {
    const settings = this.owner.services.settings;
    if (!settings) return;
    this.release = await settings.subscribe(
      { keys: ["storage.scheduledCleanup"], scope: {} },
      (event) => {
        if (event.type === "changed")
          this.set(
            event.entries.find((entry) => entry.key === "storage.scheduledCleanup")?.value === true,
          );
      },
    );
    this.set((await settings.get("storage.scheduledCleanup")).value === true);
  }
  private set(enabled: boolean): void {
    this.enabled = enabled;
    this.cancel?.();
    this.cancel = undefined;
    if (!enabled || this.closed) return;
    this.owner.store
      .statement("INSERT OR IGNORE INTO storage_schedule VALUES (1,?)")
      .run(this.owner.now() + 86400000);
    this.next();
  }
  private next(): void {
    if (!this.enabled || this.closed || this.flight) return;
    const due = Number(
      this.owner.store.statement("SELECT due FROM storage_schedule WHERE id=1").get()?.due,
    );
    this.cancel = this.schedule(Math.max(1, Math.min(60000, due - this.owner.now())), () => {
      this.cancel = undefined;
      if (due > this.owner.now()) {
        this.next();
        return;
      }
      this.flight = this.service
        .scheduledCleanup(() => this.enabled && !this.closed)
        .then((result) => {
          this.owner.store
            .statement("UPDATE storage_schedule SET due=? WHERE id=1")
            .run(this.owner.now() + (result.state === "pending" ? 60000 : 86400000));
        })
        .catch(() => {
          this.owner.store
            .statement("UPDATE storage_schedule SET due=? WHERE id=1")
            .run(this.owner.now() + 60000);
        })
        .finally(() => {
          this.flight = undefined;
          this.next();
        });
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancel?.();
    this.release?.();
    await this.flight;
  }
}
