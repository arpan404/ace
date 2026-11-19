import type { LockedUseObservation, LockedUseStatus } from "@ace/protocol";

/**
 * Detects and changes this Mac's locked computer use component: the one ordered source of its
 * state. Every method resolves to an observation of the Mac as it is, never a stored flag, and
 * `subscribe` reports later observations (an install finishing, the person approving, drift
 * found) until the returned stop function runs.
 *
 * All observations, whether returned or pushed, share one revision counter: an observation
 * made later has a higher revision, so the daemon can drop any that arrive out of order.
 */
export interface LockedUseInstaller {
  detectStatus(): Promise<LockedUseObservation>;
  install(): Promise<LockedUseObservation>;
  remove(): Promise<LockedUseObservation>;
  repair(): Promise<LockedUseObservation>;
  subscribe(listener: (observation: LockedUseObservation) => void): () => void;
}

export class LockedUseNotImplementedError extends Error {
  constructor(action: string) {
    super(`Locked computer use ${action} is not yet implemented`);
    this.name = "LockedUseNotImplementedError";
  }
}

/**
 * Stands in until the native installer lands: off everywhere but macOS, needs-approval on macOS,
 * and every change refused with a clear error. Never touches the machine.
 */
export function placeholderLockedUseInstaller(platform: NodeJS.Platform): LockedUseInstaller {
  const status: LockedUseStatus =
    platform === "darwin" ? { state: "needsApproval" } : { state: "off" };
  // Nothing ever changes, so one observation stands for every read.
  const observation: LockedUseObservation = { revision: 0, status };
  return {
    detectStatus: () => Promise.resolve(observation),
    install: () => Promise.reject(new LockedUseNotImplementedError("install")),
    remove: () => Promise.reject(new LockedUseNotImplementedError("removal")),
    repair: () => Promise.reject(new LockedUseNotImplementedError("repair")),
    subscribe: () => () => {},
  };
}
