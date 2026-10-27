import type { AppUpdateReport } from "@ace/protocol";
import type { UpdateStatus } from "../../shared/contract.ts";

/** States in which a newer version is on offer: found, on its way, or waiting for a restart. */
const offered = new Set<UpdateStatus["state"]>([
  "available",
  "downloading",
  "downloaded",
  "installing",
]);
const fetched = new Set<UpdateStatus["state"]>(["downloaded", "installing"]);

/** What the daemon is told about this app's update, from the updater's own status. */
export function appUpdateReport(status: UpdateStatus): AppUpdateReport {
  const available = offered.has(status.state) ? status.version : null;
  const downloaded = available !== null && fetched.has(status.state);
  return {
    version: status.currentVersion,
    available,
    downloaded,
    // Only an in-place update installs on restart; others open the release page.
    restartRequired: downloaded && status.inPlace,
    releaseUrl: status.releaseUrl,
  };
}

export interface UpdateReportPorts {
  /** Sends one report to the daemon this app runs (`probe.ts` `reportAppUpdate`). */
  send(report: AppUpdateReport): Promise<void>;
  /** Takes the report back (`probe.ts` `withdrawAppUpdate`), as the app quits. */
  withdraw(): Promise<void>;
  log(message: string): void;
  timers: { set(delayMs: number, callback: () => void): () => void };
}

/**
 * How often the report is sent again unchanged. The daemon drops a report it hasn't heard for a
 * minute (`app-update-board.ts`), so this keeps it alive while the app runs and brings it back
 * after the daemon dropped it.
 */
export const updateRenewMs = 20_000;

/**
 * Tells this app's daemon about its update status (ADR 0041's loopback host-token routes), so
 * paired clients can show it: on every change, and once each time the daemon comes up, since
 * the daemon keeps it only in memory. A failed send waits for the next change or connection.
 */
export class UpdateReporter {
  #ports: UpdateReportPorts;
  #report: AppUpdateReport | undefined;
  #sent: string | undefined;
  #connected = false;
  #withdrawn = false;
  #sending: Promise<void> = Promise.resolve();
  #stopRenewing: (() => void) | undefined;
  constructor(ports: UpdateReportPorts) {
    this.#ports = ports;
  }
  status(status: UpdateStatus): void {
    this.#report = appUpdateReport(status);
    this.#push();
  }
  /** The daemon is running (true) or gone (false); each new connection hears the report again. */
  connected(on: boolean): void {
    if (on === this.#connected) return;
    this.#connected = on;
    this.#sent = undefined;
    this.#push();
    this.#renew();
  }
  /**
   * The app is quitting or stopping its daemon: take the report back so no client keeps showing
   * it, and send nothing more. Settles once the daemon was told, or could not be.
   */
  withdraw(): Promise<void> {
    this.#withdrawn = true;
    this.#stopRenewing?.();
    this.#stopRenewing = undefined;
    this.#sending = this.#sending.then(async () => {
      if (!this.#connected || this.#sent === undefined) return;
      try {
        await this.#ports.withdraw();
        this.#sent = undefined;
      } catch (error) {
        this.#ports.log(`Couldn't withdraw the app's update status: ${String(error)}`);
      }
    });
    return this.#sending;
  }
  /** Settles once every report asked for so far has been sent or has failed. */
  settled(): Promise<void> {
    return this.#sending;
  }
  /** While connected, sends the report again every `updateRenewMs`, unchanged or not. */
  #renew(): void {
    this.#stopRenewing?.();
    this.#stopRenewing = undefined;
    if (!this.#connected || this.#withdrawn) return;
    this.#stopRenewing = this.#ports.timers.set(updateRenewMs, () => {
      this.#sent = undefined;
      this.#push();
      this.#renew();
    });
  }
  #push(): void {
    this.#sending = this.#sending.then(async () => {
      const report = this.#report;
      if (!report || !this.#connected || this.#withdrawn) return;
      const key = JSON.stringify(report);
      if (key === this.#sent) return;
      try {
        await this.#ports.send(report);
        this.#sent = key;
      } catch (error) {
        this.#ports.log(`Couldn't report the app's update status to its daemon: ${String(error)}`);
      }
    });
  }
}
