import { LockedUseObservation } from "@ace/protocol";
import type { LockedUseInstaller } from "@ace/screen";

export type LockedUseAction = "install" | "remove" | "repair";

export class LockedUseBusyError extends Error {
  constructor() {
    super("Another locked use change is running");
    this.name = "LockedUseBusyError";
  }
}

/**
 * This Mac's locked use state for the whole daemon. Detections, action results and pushed
 * reports all pass through `observe`, which keeps only an observation newer than the one it
 * holds, so the state never moves back to an older reading whatever order they arrive in.
 * One change runs at a time across every socket.
 */
export class LockedUseState {
  #installer: LockedUseInstaller;
  #current: LockedUseObservation | undefined;
  #listeners = new Set<(observation: LockedUseObservation) => void>();
  #stopInstaller: (() => void) | undefined;
  #acting = false;

  constructor(installer: LockedUseInstaller) {
    this.#installer = installer;
  }

  /** The newest observation so far, if any. */
  get current(): LockedUseObservation | undefined {
    return this.#current;
  }

  /** Follow newer observations; the installer is watched while anyone follows. */
  watch(listener: (observation: LockedUseObservation) => void): () => void {
    this.#listeners.add(listener);
    this.#stopInstaller ??= this.#installer.subscribe((value) => this.#observe(value));
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size) return;
      this.#stopInstaller?.();
      this.#stopInstaller = undefined;
    };
  }

  /** Read the Mac again; resolves to the newest observation, which may be newer than the read. */
  async refresh(): Promise<LockedUseObservation> {
    return this.#newest(this.#observe(await this.#installer.detectStatus()));
  }

  /** Run a change; resolves to the newest observation afterwards. */
  async run(action: LockedUseAction): Promise<LockedUseObservation> {
    if (this.#acting) throw new LockedUseBusyError();
    this.#acting = true;
    try {
      return this.#newest(this.#observe(await this.#installer[action]()));
    } finally {
      this.#acting = false;
    }
  }

  #newest(observation: LockedUseObservation | undefined): LockedUseObservation {
    if (!observation) throw new Error("The installer reported an unreadable locked use state");
    return observation;
  }

  #observe(value: unknown): LockedUseObservation | undefined {
    const parsed = LockedUseObservation.safeParse(value);
    if (!parsed.success) return this.#current;
    if (this.#current && parsed.data.revision <= this.#current.revision) return this.#current;
    this.#current = parsed.data;
    for (const listener of this.#listeners) listener(parsed.data);
    return this.#current;
  }
}
