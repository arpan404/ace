import { adoptedProcess } from "./adopted.ts";
import { foundDaemon, readLockOwner, readOwnership, writeOwnership } from "./ownership.ts";
import { requestStop } from "./stop-request.ts";
import type { SupervisorPorts } from "./supervisor-config.ts";

/** How often an adopted daemon, no longer this process's child, is looked for. */
const adoptedPollMs = 250;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is there, owned by someone else, which a daemon of this home never is.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * The supervisor's ports for the daemon an ace app started in `home` (ADR 0185): recording the
 * one this app spawned once it holds the home's lock, and claiming one an earlier launch left
 * running, as the app's own (`version` matches) or to replace (it does not).
 */
export function ownershipPorts(input: {
  home: string;
  /** This app's version: the version of the daemon it bundles. */
  version: string;
  platform: NodeJS.Platform;
  now: () => number;
}): Pick<SupervisorPorts, "claimOwned" | "recordOwned"> {
  const { home } = input;
  const owns = async (pid: number) => (await readLockOwner(home))?.pid === pid;
  return {
    async claimOwned() {
      const [record, lock] = await Promise.all([readOwnership(home), readLockOwner(home)]);
      const found = foundDaemon(record, lock, input.version);
      if (found.kind === "external") return undefined;
      const process = adoptedProcess(found.pid, {
        alive,
        owns,
        signal: (pid, signal) => globalThis.process.kill(pid, signal),
        ...(input.platform === "win32"
          ? { requestStop: (pid: number) => requestStop(home, pid) }
          : {}),
        pollMs: adoptedPollMs,
        timers: {
          set(delayMs, callback) {
            const timer = setTimeout(callback, delayMs);
            timer.unref();
            return () => clearTimeout(timer);
          },
        },
      });
      return found.kind === "adopt"
        ? { process, replace: false, version: input.version }
        : { process, replace: true, version: found.version };
    },
    async recordOwned(daemon) {
      const lock = await readLockOwner(home);
      if (daemon.pid === undefined || lock?.pid !== daemon.pid) return false;
      await writeOwnership(home, {
        pid: lock.pid,
        lockId: lock.id,
        version: input.version,
        startedAt: input.now(),
      });
      return true;
    },
  };
}
