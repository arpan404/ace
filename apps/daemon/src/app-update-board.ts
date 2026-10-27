import type { AppUpdate, AppUpdateReport } from "@ace/protocol";

/**
 * How long a report stays without a newer report or a health check from the app. The desktop
 * app checks its daemon every few seconds, so this is many missed checks: the app has gone.
 */
export const appUpdateExpiryMs = 60_000;

export interface AppUpdateClock {
  now(): number;
  /** Runs `callback` after `ms`; returns the cancel. */
  delay(callback: () => void, ms: number): () => void;
}

/**
 * The desktop app's last update report, in memory only. It goes when the app withdraws it (on
 * quit), or when neither a report nor a health check has come from the app for
 * `appUpdateExpiryMs`, so clients never show an old "Restart to finish updating".
 */
export class AppUpdateBoard {
  #report: AppUpdateReport | null = null;
  #reportedAt: number | null = null;
  #seenAt = 0;
  #cancel: (() => void) | undefined;
  readonly #clock: AppUpdateClock;
  readonly #expiryMs: number;
  readonly #listeners = new Set<(update: AppUpdate) => void>();
  constructor(clock: AppUpdateClock, expiryMs = appUpdateExpiryMs) {
    this.#clock = clock;
    this.#expiryMs = expiryMs;
  }
  current(): AppUpdate {
    return { report: this.#report, reportedAt: this.#reportedAt };
  }
  /** Keeps `report`; listeners hear it only when it differs from the last one. */
  set(report: AppUpdateReport): AppUpdate {
    const changed = JSON.stringify(report) !== JSON.stringify(this.#report);
    this.#report = report;
    this.#reportedAt = this.#clock.now();
    this.seen();
    if (changed) this.#tell();
    return this.current();
  }
  /** The app checked the daemon's health: its report is still current. */
  seen(): void {
    if (!this.#report) return;
    this.#seenAt = this.#clock.now();
    this.#cancel?.();
    this.#cancel = this.#clock.delay(() => this.#expire(), this.#expiryMs);
  }
  /** The app withdrew its report (it is quitting or stopping the daemon). */
  clear(): AppUpdate {
    this.#cancel?.();
    this.#cancel = undefined;
    const had = this.#report !== null;
    this.#report = null;
    this.#reportedAt = null;
    if (had) this.#tell();
    return this.current();
  }
  close(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
  onChange(listener: (update: AppUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #expire(): void {
    if (this.#report && this.#clock.now() - this.#seenAt >= this.#expiryMs) this.clear();
  }
  #tell(): void {
    for (const listener of this.#listeners) listener(this.current());
  }
}
