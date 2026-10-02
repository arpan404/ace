import type { ProcessIdentity } from "./decode.ts";

export interface ShutdownScheduler {
  now(): number;
  delay(ms: number): Promise<void>;
}
export interface ProcessControl {
  read(): Promise<ProcessIdentity[]>;
  signal(group: number, signal: NodeJS.Signals): void;
}

function ownedGroups(rows: ProcessIdentity[], owner: string): Set<number> {
  return new Set(
    rows
      .filter((row) => row.owner === owner && row.group > 0 && !row.state.startsWith("Z"))
      .map((row) => row.group),
  );
}

/** The reserved group is stopped with everything else, but killed LAST. Its
 * lifetime proves the session identity; after release we only verify, never signal. */
export function sessionOwnership(
  owner: string,
  control: ProcessControl,
  scheduler: ShutdownScheduler,
  leaseGroup: number,
) {
  let leaseEnded = false;
  let stopped = false;
  async function groups() {
    const live = ownedGroups(await control.read(), owner);
    return !leaseEnded && !live.has(leaseGroup) ? new Set<number>() : live;
  }
  async function signalSelected(selected: Set<number>, requested: NodeJS.Signals) {
    const failures: unknown[] = [];
    for (const group of selected) {
      try {
        control.signal(group, requested);
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
  async function escalate(failures: unknown[] = []) {
    const deadline = scheduler.now() + 1000;
    for (let sweep = 0; sweep < 32; sweep++) {
      if (!leaseEnded) {
        try {
          await signalSelected(await groups(), "SIGSTOP");
        } catch (error) {
          failures.push(error);
        }
        const live = await groups();
        if (!live.size) {
          stopped = true;
          break;
        }
        const jobs = new Set([...live].filter((group) => group !== leaseGroup));
        try {
          if (jobs.size) await signalSelected(jobs, "SIGKILL");
          else {
            await signalSelected(live, "SIGKILL");
            leaseEnded = true;
          }
        } catch (error) {
          failures.push(error);
        }
      } else if (!(await groups()).size) {
        stopped = true;
        break;
      }
      if (scheduler.now() >= deadline) break;
      await scheduler.delay(0);
    }
    if (!stopped && !(await groups()).size) stopped = true;
    if (!stopped) failures.push(new Error("Terminal processes survived bounded shutdown"));
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
