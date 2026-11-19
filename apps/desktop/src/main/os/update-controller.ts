import type { ReleaseLine } from "@ace/service/release-line";
import type { UpdateReleaseNote, UpdateStatus } from "../../shared/contract.ts";

/** A newer release and what changed since this version. */
export interface UpdateOffer {
  version: string;
  notes: UpdateReleaseNote[];
  olderReleases: number;
  /** Its release page, when the version alone doesn't name it (a beta's tag, ADR 0177). */
  releaseUrl?: string;
}

/** The line's release is older than this version and can't read its data: why, in a sentence. */
export interface UpdateBlocked {
  blocked: string;
}

/** The installer itself (electron-updater in the app); tests substitute a scripted one. */
export interface UpdateEngine {
  /** Whether this install can replace itself; otherwise a newer version opens its release. */
  readonly canInstall: boolean;
  /**
   * The release the feed offers, undefined when this one is current, or why an older release
   * on the chosen line is held back.
   */
  check(): Promise<UpdateOffer | UpdateBlocked | undefined>;
  /** Downloads the version `check` found and resolves once it can be installed. */
  download(progress: (percent: number) => void): Promise<void>;
  /** Quits the app and starts the downloaded version. */
  install(): void;
  /**
   * Runs the downgrade guard again on what the home holds now, for an offer older than this
   * version (ADR 0177): why it is now refused, or undefined when it still may install.
   * Undefined at once (no promise) when nothing older is on offer or downloaded.
   */
  recheck?(): Promise<UpdateBlocked | undefined> | undefined;
  /** Drops the offer the guard now refuses, so nothing installs it, on quit included. */
  discard?(): void;
}

export interface UpdatePorts {
  engine: UpdateEngine;
  /** This app's version. */
  version: string;
  /** False for a build without the release feed: nothing is ever checked. */
  enabled: boolean;
  /** The line the person updates from now (ADR 0177). */
  line(): ReleaseLine;
  /** The line this build belongs to. */
  buildLine: ReleaseLine;
  releaseUrl(version: string): string;
  /**
   * Closes admission for new work and waits for running agents to finish naturally,
   * reporting how many still work. True once none do; false (admission reopened) when work
   * remains at the deadline.
   */
  drain(waiting: (count: number) => void): Promise<boolean>;
  /** Threads still at work in the daemon this app started; 0 when the app runs none. */
  busy(): Promise<number>;
  /**
   * Stops the browser backend and the daemon this app started: the app quits next. `spadeMode`
   * is how Spade's swap after the restart treats its running work (ADR 0123): `now` after a
   * confirmed Restart, `idle` when the update waited for agents to finish.
   */
  prepareQuit(spadeMode: "idle" | "now"): Promise<void>;
  /** Quits without installing, when the installer refused after `prepareQuit`. */
  quit(): void;
  report(status: UpdateStatus): void;
  log(level: "info" | "warn", message: string): void;
  /** The clock for how long each step of a restart took, in the log. */
  now(): number;
}

export type CheckOrigin = "person" | "background";

/** What the daemon asks of the app (`AppUpdateInstruction`, ADR 0113). */
export interface RemoteInstruction {
  action: string;
  mode: string;
  version: string;
}

export const stalledMessage = "Agents are still working. Restart again once they finish.";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The app's update, from check to restart (ADR 0091). Checks run in the background and on
 * request; a found update waits for the person to download it, and a downloaded one for
 * their Restart. The person confirms that Restart knowing how many agents it stops, so it
 * stops them at once: the daemon's shutdown interrupts each turn and keeps its progress.
 * `apply` (the CLI's `ace update apply`) asks nobody, so it drains running agents first and
 * stays downloaded if work remains.
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
      line: ports.line(),
      buildLine: ports.buildLine,
      blocked: null,
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

  /**
   * The person picked another line (ADR 0177): a person's check on it, so Settings shows what it
   * offers, or why it holds back. A download or restart under way only takes the new line.
   */
  async lineChanged(): Promise<UpdateStatus> {
    // A check already running asked the old line: let it settle, then ask the new one.
    if (this.checking) await this.checking;
    const state = this.status.state;
    if (state === "disabled" || state === "downloading" || state === "installing")
      return this.set({ ...this.status, blocked: null });
    return this.check("person");
  }

  /** Downloads the update on offer. */
  async download(): Promise<UpdateStatus> {
    // A check also changes the engine's selected release. Let it settle before starting
    // the download, so neither its offer nor its error can overwrite download progress.
    if (this.checking) await this.checking;
    if (this.status.state !== "available" || !this.status.version || !this.status.inPlace)
      return this.status;
    const allowed = this.stillAllowed();
    if (allowed && !(await allowed)) return this.status;
    const offer = this.status;
    if (offer.state !== "available" || !offer.version) return this.status;
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
    if (this.installWhenReady) return this.installWhenIdle();
    return this.status;
  }

  /**
   * How many agents the person's Restart would stop: those working in the daemon this app
   * started. Undefined when that daemon could not say.
   */
  async busy(): Promise<number | undefined> {
    try {
      return await this.ports.busy();
    } catch (error) {
      this.ports.log("warn", `Counting running agents failed: ${message(error)}`);
      return undefined;
    }
  }

  /** The person's confirmed Restart: stop running agents now and restart into the update. */
  async install(): Promise<UpdateStatus> {
    this.ports.log("info", "Restart to update: asked");
    // A pending check must finish before the restart can change the update's state.
    if (this.checking) {
      const waited = this.ports.now();
      await this.checking;
      this.ports.log(
        "info",
        `Restart to update: waited ${this.ports.now() - waited} ms for a check in flight`,
      );
    }
    if (this.status.state !== "downloaded") return this.status;
    this.installWhenReady = false;
    const allowed = this.stillAllowed();
    if (allowed && !(await allowed)) return this.status;
    if (this.status.state !== "downloaded") return this.status;
    this.set({ ...this.status, state: "installing", waiting: 0, error: null });
    return this.restart("now");
  }

  /** Restart into the downloaded update once running agents finish (`ace update apply`). */
  private async installWhenIdle(): Promise<UpdateStatus> {
    if (this.checking) await this.checking;
    if (this.status.state === "downloading") this.installWhenReady = true;
    if (this.status.state !== "downloaded") return this.status;
    this.installWhenReady = false;
    const allowed = this.stillAllowed();
    if (allowed && !(await allowed)) return this.status;
    if (this.status.state !== "downloaded") return this.status;
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
    return this.restart("idle");
  }

  /**
   * Stops the browser backend and the daemon (its shutdown interrupts turns), then installs.
   * From here the app only closes and reopens: the page says so instead of any reconnecting.
   */
  private async restart(spadeMode: "idle" | "now"): Promise<UpdateStatus> {
    this.set({ ...this.status, restarting: true });
    const stopping = this.ports.now();
    this.ports.log("info", "Restart to update: stopping the browser backend and the daemon");
    try {
      await this.ports.prepareQuit(spadeMode);
    } catch (error) {
      this.ports.log("warn", `Stopping before the update failed: ${message(error)}`);
    }
    this.ports.log(
      "info",
      `Restart to update: stopped in ${this.ports.now() - stopping} ms; starting the installer`,
    );
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
    if (this.status.state === "downloaded") return this.installWhenIdle();
    if (this.status.state === "downloading") return this.status;
    const found = this.status.state === "available" ? this.status : await this.check("person");
    if (found.state === "available" && found.inPlace) return this.download();
    if (found.state === "downloaded") return this.installWhenIdle();
    this.installWhenReady = false;
    return found;
  }

  /**
   * An update asked for from another client through this app's daemon (ADR 0113). Only the
   * release the person saw there is installed: a different one on offer here is left alone.
   * `download` fetches it. `install` when `idle` drains running agents first, as `ace update
   * apply` does (the daemon asks only once none work); `now` stops them at once, as a confirmed
   * Restart does, since the person confirmed on that client. Stopped turns continue after the
   * restart.
   */
  async remote(instruction: RemoteInstruction): Promise<UpdateStatus> {
    if (this.checking) await this.checking;
    let found = this.status;
    if (found.version !== instruction.version && found.state !== "downloading")
      found = await this.check("background");
    if (found.version !== instruction.version) {
      this.ports.log(
        "warn",
        `An update to ${instruction.version} was asked for, but ${found.version ?? "nothing"} is on offer.`,
      );
      return found;
    }
    if (instruction.action === "download")
      return found.state === "available" ? this.download() : found;
    if (instruction.action !== "install") return found;
    if (instruction.mode !== "now") return this.apply();
    if (found.state === "available" && (await this.download()).state !== "downloaded")
      return this.status;
    return this.install();
  }

  /**
   * The guard once more before a download or an install (ADR 0177): the home may have gained a
   * newer format since the check (Spade started for the first time, say). A release it now
   * refuses is dropped from the engine and from the status, which says why.
   */
  private stillAllowed(): Promise<boolean> | undefined {
    // Nothing to look at again answers at once (undefined), so a download or a restart starts
    // in step with the person's click.
    const again = this.ports.engine.recheck?.();
    return again ? this.heldBack(again) : undefined;
  }

  private async heldBack(again: Promise<UpdateBlocked | undefined>): Promise<boolean> {
    let refused: UpdateBlocked | undefined;
    try {
      refused = await again;
    } catch (error) {
      refused = { blocked: `ace couldn't check this install's data: ${message(error)}` };
    }
    if (!refused) return true;
    this.ports.log("warn", `Update to ${this.status.version ?? "?"} held back: ${refused.blocked}`);
    this.ports.engine.discard?.();
    this.installWhenReady = false;
    this.set({
      ...this.status,
      state: "current",
      version: null,
      releaseUrl: null,
      percent: null,
      waiting: 0,
      notes: [],
      olderReleases: 0,
      blocked: refused.blocked,
      error: null,
    });
    return false;
  }

  private async find(before: UpdateStatus, origin: CheckOrigin): Promise<UpdateStatus> {
    let offer: UpdateOffer | UpdateBlocked | undefined;
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
    if (!offer || "blocked" in offer) {
      const blocked = offer ? offer.blocked : null;
      if (before.state === "downloaded") return this.set({ ...before, blocked });
      return this.set({
        ...before,
        state: "current",
        version: null,
        releaseUrl: null,
        percent: null,
        notes: [],
        olderReleases: 0,
        blocked,
        error: null,
      });
    }
    if (before.state === "downloaded" && before.version === offer.version)
      return this.set({
        ...before,
        notes: offer.notes.length > 0 ? offer.notes : before.notes,
        blocked: null,
        error: null,
      });
    return this.set({
      ...before,
      state: "available",
      version: offer.version,
      releaseUrl: offer.releaseUrl ?? this.ports.releaseUrl(offer.version),
      blocked: null,
      inPlace: this.ports.engine.canInstall,
      percent: null,
      notes: offer.notes,
      olderReleases: offer.olderReleases,
      error: null,
    });
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = { ...status, line: this.ports.line() };
    this.ports.report(this.status);
    return this.status;
  }
}
