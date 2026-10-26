import type { WindowsJobFactory } from "@ace/provider-kit/process-containment";
import { createKillOnCloseJob } from "@ace/provider-kit/process-containment";
import type { ProcessSpawner } from "./io.ts";
import type { ChromeLaunch } from "./chrome-instance.ts";

const profileFlag = "--user-data-dir=";

/**
 * Windows has no process groups and no `ps` for the guardian. Each profile's Chrome joins a
 * kill-on-close job instead: the kernel ends the whole tree (GPU, renderers, crashpad) when the
 * daemon's handle closes, even when the daemon crashes, and closing the guard ends any member
 * that outlived the browser process. A machine without jobs keeps the `taskkill /T` stop.
 */
export function chromeJobs(
  spawn: ProcessSpawner,
  createJob: WindowsJobFactory = createKillOnCloseJob,
): Pick<ChromeLaunch, "guard" | "spawn"> {
  const jobs = new Map<string, ReturnType<WindowsJobFactory>>();
  return {
    guard: async (profile) => {
      const job = createJob();
      jobs.set(profile, job);
      return {
        close: async () => {
          if (jobs.get(profile) === job) jobs.delete(profile);
          job?.dispose();
        },
      };
    },
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      const profile = args.find((arg) => arg.startsWith(profileFlag))?.slice(profileFlag.length);
      const job = profile === undefined ? undefined : jobs.get(profile);
      if (job && child.pid !== undefined) job.assign(child.pid);
      return child;
    },
  };
}
