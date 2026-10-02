import type { ProcessIdentity } from "./decode.ts";

export interface ShutdownScheduler {
  now(): number;
  delay(ms: number): Promise<void>;
}
export interface ProcessControl {
  read(): Promise<ProcessIdentity[]>;
  signal(group: number, signal: NodeJS.Signals): void;
  /** Atomically pin a group in this PTY session, then signal it. False means foreign/gone. */
  signalOwned?(group: number, signal: NodeJS.Signals): Promise<boolean>;
  /** Freeze the original shell PID while leaving the FIFO keeper runnable. */
  stopShell?(): void;
  /** Safe even when inventory fails: the I/O boundary verifies its private lease. */
  resumeLease?(): void;
}

function ownedGroups(rows: ProcessIdentity[], owner: string): Set<number> {
  return new Set(
    rows
      .filter((row) => row.owner === owner && row.group > 0 && !row.state.startsWith("Z"))
      .map((row) => row.group),
  );
}

/** The reserved shell is stopped without its keeper, and its group killed LAST. Its
 * lifetime proves the session identity; after release we only verify, never signal. */
export function sessionOwnership(
  owner: string,
  control: ProcessControl,
  scheduler: ShutdownScheduler,
  leaseGroup: number,
) {
  let leaseEnded = false;
  let stopped = false;
  const paused = new Set<number>();
  async function groups() {
    const live = ownedGroups(await control.read(), owner);
    return !leaseEnded && !live.has(leaseGroup) ? new Set<number>() : live;
  }
  async function signalSelected(selected: Set<number>, requested: NodeJS.Signals) {
    const failures: unknown[] = [];
    for (const group of selected) {
      try {
        // A preceding signal may have made another group exit and be recycled.
        if (!(await groups()).has(group)) continue;
        // The guardian may apply STOP before an acknowledgment fails to arrive.
        if (requested === "SIGSTOP") paused.add(group);
        if (group !== leaseGroup) {
          if (!control.signalOwned)
            throw new Error("Missing atomic session-group signaling boundary");
          if (!(await control.signalOwned(group, requested))) continue;
        } else if (requested === "SIGSTOP") {
          if (!control.stopShell) throw new Error("Missing shell pause boundary");
          control.stopShell();
        } else control.signal(group, requested);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EPERM" &&
          !ownedGroups(await control.read(), owner).has(group)
        )
          continue;
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Failed to signal terminal processes");
  }
  async function resumePaused() {
    // Pinned identities survive inventory failures. Never await discovery here.
    const failures: unknown[] = [];
    for (const group of paused) {
      if (group === leaseGroup) continue;
      try {
        if (!control.signalOwned) throw new Error("Missing atomic session-group recovery boundary");
        await control.signalOwned(group, "SIGCONT");
        paused.delete(group);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Failed to resume terminal groups");
  }
  async function escalate(failures: unknown[] = []) {
    const deadline = scheduler.now() + 1000;
    try {
      for (let sweep = 0; sweep < 32; sweep++) {
        if (!leaseEnded) {
          const discovered = await groups();
          if (discovered.has(leaseGroup)) {
            paused.add(leaseGroup);
            control.stopShell?.();
          }
          await signalSelected(
            new Set([...discovered].filter((group) => group !== leaseGroup)),
            "SIGSTOP",
          );
          let live = await groups();
          const jobs = new Set([...live].filter((group) => group !== leaseGroup));
          if (jobs.size) await signalSelected(jobs, "SIGKILL");
          // Finish this stop/kill transaction before applying the loop budget.
          // Slow inventories must not leave only the stopped shell/keeper alive.
          live = await groups();
          if (live.size === 1 && live.has(leaseGroup)) {
            await signalSelected(live, "SIGKILL");
            leaseEnded = true;
          }
        }
        if (!(await groups()).size) {
          stopped = true;
          break;
        }
        if (scheduler.now() >= deadline) break;
        await scheduler.delay(0);
      }
      if (!stopped && !(await groups()).size) stopped = true;
      if (!stopped) failures.push(new Error("Terminal processes survived bounded shutdown"));
    } catch (error) {
      failures.push(error);
    } finally {
      if (!stopped && !leaseEnded) {
        try {
          await resumePaused();
        } catch (error) {
          failures.push(error);
        }
        // A stopped keeper cannot consume FIFO EOF when the daemon dies. The
        // private lease can prove its group even when process inventories fail.
        try {
          control.resumeLease?.();
        } catch (error) {
          failures.push(error);
        }
      }
      if (stopped || leaseEnded) paused.clear();
    }
    if (failures.length) throw new AggregateError(failures, "Terminal shutdown failed");
  }
  return {
    async kill(requested: NodeJS.Signals) {
      if (stopped) return;
      if (requested === "SIGKILL") await escalate();
      else if (!leaseEnded) await signalSelected(await groups(), requested);
    },
    async close(graceMs: number) {
      if (stopped) return;
      const failures: unknown[] = [];
      if (!leaseEnded) {
        try {
          await signalSelected(await groups(), "SIGTERM");
        } catch (error) {
          failures.push(error);
        }
        await scheduler.delay(graceMs);
      }
      await escalate(failures);
    },
  };
}
