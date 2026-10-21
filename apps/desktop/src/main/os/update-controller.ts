import type { UpdateReleaseNote, UpdateStatus } from "../../shared/contract.ts";

/** A newer release and what changed since this version. */
export interface UpdateOffer {
  version: string;
  notes: UpdateReleaseNote[];
  olderReleases: number;
}

/** The installer itself (electron-updater in the app); tests substitute a scripted one. */
export interface UpdateEngine {
  /** Whether this install can replace itself; otherwise a newer version opens its release. */
  readonly canInstall: boolean;
  /** The newer release the feed offers, or undefined when this one is current. */
  check(): Promise<UpdateOffer | undefined>;
  /** Downloads the version `check` found and resolves once it can be installed. */
  download(progress: (percent: number) => void): Promise<void>;
  /** Quits the app and starts the downloaded version. */
  install(): void;
}

export interface UpdatePorts {
  engine: UpdateEngine;
  /** This app's version. */
  version: string;
  /** False for a build without the release feed: nothing is ever checked. */
  enabled: boolean;
  releaseUrl(version: string): string;
  /**
   * Closes admission for new work and waits for running agents to finish naturally,
   * reporting how many still work. True once none do; false (admission reopened) when work
   * remains at the deadline.
   */
  drain(waiting: (count: number) => void): Promise<boolean>;
  /** Stops the browser backend and the daemon this app started: the app quits next. */
  prepareQuit(): Promise<void>;
  /** Quits without installing, when the installer refused after `prepareQuit`. */
  quit(): void;
  report(status: UpdateStatus): void;
  log(level: "info" | "warn", message: string): void;
}

export type CheckOrigin = "person" | "background";

export const stalledMessage = "Agents are still working. Restart again once they finish.";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The app's update, from check to restart (ADR 0091). Checks run in the background and on
 * request; a found update waits for the person to download it, and a downloaded one for
 * their Restart, which never cuts off running agents: it drains them first and stays
 * downloaded if work remains. `apply` (the CLI's `ace update apply`) runs every step.
 */
export class UpdateController {
  private ports: UpdatePorts;
  private status: UpdateStatus;
  private checking: Promise<UpdateStatus> | undefined;
  private installWhenReady = false;

  constructor(ports: UpdatePorts) {
    this.ports = ports;
    this.status = {
      state: ports.enabled ? "idle" : "disabled",
      currentVersion: ports.version,
      version: null,
      releaseUrl: null,
      inPlace: ports.engine.canInstall,
      percent: null,
      waiting: 0,
      notes: [],
      olderReleases: 0,
      error: null,
    };
  }

  current(): UpdateStatus {
    return this.status;
  }

  /**
   * Asks the feed for a newer release. A person's check shows `checking`; a background one
   * changes nothing until it finds something, and its failures stay in the log. A download
   * in progress and a restart under way are left as they are.
   */
  check(origin: CheckOrigin): Promise<UpdateStatus> {
    const state = this.status.state;
    if (state === "disabled" || state === "downloading" || state === "installing")
      return Promise.resolve(this.status);
    if (this.checking) return this.checking;
    const before = this.status;
    if (origin === "person") this.set({ ...before, state: "checking", error: null });
    this.checking = this.find(before, origin).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /** Downloads the update on offer. */
  async download(): Promise<UpdateStatus> {
    // A check also changes the engine's selected release. Let it settle before starting
    // the download, so neither its offer nor its error can overwrite download progress.
    if (this.checking) await this.checking;
    const offer = this.status;
    if (offer.state !== "available" || !offer.version || !offer.inPlace) return this.status;
    const version = offer.version;
    this.set({ ...offer, state: "downloading", percent: 0, error: null });
    try {
      await this.ports.engine.download((percent) => {
        const whole = Math.max(0, Math.min(100, Math.floor(percent)));
        if (this.status.state === "downloading" && whole !== this.status.percent)
          this.set({ ...this.status, percent: whole });
      });
    } catch (error) {
      this.installWhenReady = false;
      this.ports.log("warn", `Downloading ${version} failed: ${message(error)}`);
      return this.set({
        ...offer,
        state: "available",
        percent: null,
        error: { during: "download", message: message(error) },
      });
    }
    this.set({ ...offer, state: "downloaded", percent: 100, error: null });
    if (this.installWhenReady) return this.install();
    return this.status;
  }

  /** Restart into the downloaded update once running agents finish. */
  async install(): Promise<UpdateStatus> {
    // A pending check must finish before the drain can change the update's state.
    if (this.checking) await this.checking;
    if (this.status.state === "downloading") this.installWhenReady = true;
    if (this.status.state !== "downloaded") return this.status;
    this.installWhenReady = false;
    const ready = this.status;
    this.set({ ...ready, state: "installing", waiting: 0, error: null });
    let drained = false;
    try {
      drained = await this.ports.drain((waiting) => {
        if (this.status.state === "installing" && this.status.waiting !== waiting)
          this.set({ ...this.status, waiting });
      });
    } catch (error) {
      this.ports.log("warn", `Update drain failed: ${message(error)}`);
    }
    if (!drained)
      return this.set({ ...ready, error: { during: "install", message: stalledMessage } });
    try {
      await this.ports.prepareQuit();
    } catch (error) {
      this.ports.log("warn", `Stopping before the update failed: ${message(error)}`);
    }
    try {
      this.ports.engine.install();
    } catch (error) {
      // The daemon has stopped for good: quit, and the next launch offers the update again.
      this.ports.log("warn", `The update did not start: ${message(error)}`);
      this.ports.quit();
    }
    return this.status;
  }

  /** `ace update apply`: check, download and restart into the newest release. */
  async apply(): Promise<UpdateStatus> {
    this.installWhenReady = true;
    if (this.status.state === "downloaded") return this.install();
    if (this.status.state === "downloading") return this.status;
    const found = this.status.state === "available" ? this.status : await this.check("person");
    if (found.state === "available" && found.inPlace) return this.download();
    if (found.state === "downloaded") return this.install();
    this.installWhenReady = false;
    return found;
  }

  private async find(before: UpdateStatus, origin: CheckOrigin): Promise<UpdateStatus> {
    let offer: UpdateOffer | undefined;
    try {
      offer = await this.ports.engine.check();
    } catch (error) {
      this.ports.log("warn", `Update check failed: ${message(error)}`);
      // An update already on offer or downloaded stays; a background failure stays quiet.
      if (origin === "background" || before.version) return this.set(before);
      return this.set({
        ...before,
        state: "error",
        error: { during: "check", message: message(error) },
      });
    }
    if (!offer) {
      if (before.state === "downloaded") return this.set(before);
      return this.set({
        ...before,
        state: "current",
        version: null,
        releaseUrl: null,
        percent: null,
        notes: [],
        olderReleases: 0,
        error: null,
      });
    }
    if (before.state === "downloaded" && before.version === offer.version)
      return this.set({
        ...before,
        notes: offer.notes.length > 0 ? offer.notes : before.notes,
        error: null,
      });
    return this.set({
      ...before,
      state: "available",
      version: offer.version,
      releaseUrl: this.ports.releaseUrl(offer.version),
      inPlace: this.ports.engine.canInstall,
      percent: null,
      notes: offer.notes,
      olderReleases: offer.olderReleases,
      error: null,
    });
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.ports.report(status);
    return status;
  }
}

export interface UpdateSchedule {
  firstMs: number;
  everyMs: number;
}

/** Shortly after launch, then every half hour. */
export const updateSchedule: UpdateSchedule = { firstMs: 15_000, everyMs: 30 * 60_000 };

/** Background checks on `schedule`; returns their cancel. */
export function scheduleChecks(
  controller: UpdateController,
  timers: { set(delayMs: number, callback: () => void): () => void },
  schedule: UpdateSchedule = updateSchedule,
): () => void {
  let cancel = timers.set(schedule.firstMs, function tick() {
    void controller.check("background");
    cancel = timers.set(schedule.everyMs, tick);
  });
  return () => cancel();
}
