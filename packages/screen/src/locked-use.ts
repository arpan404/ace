import type { LockedUseStatus } from "@ace/protocol";

/**
 * Detects and changes this Mac's locked computer use component. Every method resolves to the
 * state afterwards as the Mac reports it, never to a stored flag. `subscribe` reports later
 * changes (an install finishing, the person approving, drift found) until the returned stop
 * function runs.
 */
export interface LockedUseInstaller {
  detectStatus(): Promise<LockedUseStatus>;
  install(): Promise<LockedUseStatus>;
  remove(): Promise<LockedUseStatus>;
  repair(): Promise<LockedUseStatus>;
  subscribe(listener: (status: LockedUseStatus) => void): () => void;
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
  return {
    detectStatus: () => Promise.resolve(status),
    install: () => Promise.reject(new LockedUseNotImplementedError("install")),
    remove: () => Promise.reject(new LockedUseNotImplementedError("removal")),
    repair: () => Promise.reject(new LockedUseNotImplementedError("repair")),
    subscribe: () => () => {},
  };
}
