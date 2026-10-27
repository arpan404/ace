import type { AppUpdate, AppUpdateReport } from "@ace/protocol";

/**
 * The desktop app's last update report, in memory only: a restarted daemon reads Unknown until
 * the app reports again, which it does each time it reaches the daemon.
 */
export class AppUpdateBoard {
  #report: AppUpdateReport | null = null;
  readonly #listeners = new Set<(update: AppUpdate) => void>();
  current(): AppUpdate {
    return { report: this.#report };
  }
  /** Keeps `report`; listeners hear it only when it differs from the last one. */
  set(report: AppUpdateReport): AppUpdate {
    const changed = JSON.stringify(report) !== JSON.stringify(this.#report);
    this.#report = report;
    if (changed) for (const listener of this.#listeners) listener(this.current());
    return this.current();
  }
  onChange(listener: (update: AppUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
