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

/** No cached process/group IDs: each sweep proves current session ownership anew. */
export function sessionOwnership(
  owner: string,
  control: ProcessControl,
  scheduler: ShutdownScheduler,
) {
  async function signal(requestedSignal: NodeJS.Signals): Promise<boolean> {
    const groups = ownedGroups(await control.read(), owner);
    const failures: unknown[] = [];
    for (const group of groups) {
      try {
        control.signal(group, requestedSignal);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
        // Darwin may return EPERM when the last live group member becomes a zombie.
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
    return groups.size > 0;
  }
  return {
    kill: signal,
    async close(graceMs: number): Promise<void> {
      const failures: unknown[] = [];
      try {
        await signal("SIGTERM");
      } catch (error) {
        failures.push(error);
      }
      await scheduler.delay(graceMs);
      const deadline = scheduler.now() + 1000;
      // Rescan after grace to include new jobs. Freeze survivors before killing to
      // prevent fork churn. Both elapsed time and sweep count bound supervision.
      for (let sweep = 0; sweep < 32; sweep++) {
        let live = true;
        try {
          live = await signal("SIGSTOP");
        } catch (error) {
          failures.push(error);
        }
        if (!live) break;
        try {
          await signal("SIGKILL");
        } catch (error) {
          failures.push(error);
        }
        if (scheduler.now() >= deadline) break;
        await scheduler.delay(0);
      }
      if (ownedGroups(await control.read(), owner).size)
        failures.push(new Error("Terminal processes survived bounded shutdown"));
      if (failures.length) throw new AggregateError(failures, "Terminal shutdown failed");
    },
  };
}
