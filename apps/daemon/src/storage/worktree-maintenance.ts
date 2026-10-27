import type { StorageOwner } from "./types.ts";
import type { StorageService } from "./service.ts";
import type { StorageSchedule } from "./schedule.ts";

/** Daemon-local preferences; no provider or hosting-service API is involved. */
export class WorktreeMaintenance {
  private owner: StorageOwner;
  private service: StorageService;
  private schedule: StorageSchedule;
  private failed: (error: unknown) => void;
  private days: number | null = null;
  private backup = false;
  private revision = 0;
  private cancel: (() => void) | undefined;
  private release: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private closed = false;
  constructor(
    owner: StorageOwner,
    service: StorageService,
    schedule: StorageSchedule,
    failed: (error: unknown) => void,
  ) {
    this.owner = owner;
    this.service = service;
    this.schedule = schedule;
    this.failed = failed;
  }
  async start(): Promise<void> {
    const settings = this.owner.services.settings;
    if (!settings) return;
    this.release = await settings.subscribe(
      { keys: ["storage.worktreeRetentionDays", "storage.backupWorktrees"], scope: {} },
      (event) => {
        if (event.type !== "changed") return;
        for (const entry of event.entries) {
          if (entry.key === "storage.worktreeRetentionDays")
            this.days = typeof entry.value === "number" ? entry.value : null;
          if (entry.key === "storage.backupWorktrees") this.backup = entry.value === true;
        }
        this.revision++;
        this.arm(2000);
      },
    );
    this.days = (await settings.get("storage.worktreeRetentionDays")).value;
    this.backup = (await settings.get("storage.backupWorktrees")).value;
    this.arm(30000);
  }
  private arm(delay: number): void {
    this.cancel?.();
    this.cancel = undefined;
    if (this.closed || this.flight || (this.days === null && !this.backup)) return;
    this.cancel = this.schedule(delay, () => {
      this.cancel = undefined;
      const revision = this.revision;
      const days = this.days;
      const backup = this.backup;
      const allowed = () => !this.closed && this.revision === revision;
      this.flight = (async () => {
        if (backup) await this.service.backupWorktrees(allowed);
        if (days !== null && allowed()) await this.service.cleanupWorktrees(days, allowed);
      })()
        .catch(this.failed)
        .finally(() => {
          this.flight = undefined;
          this.arm(this.revision === revision ? 3600000 : 2000);
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
