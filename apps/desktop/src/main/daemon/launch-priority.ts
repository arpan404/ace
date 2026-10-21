import { spawnSync } from "node:child_process";

/** A program and its arguments, as handed to `spawn`. */
export interface Launch {
  command: string;
  args: string[];
}

/** What the launch policy needs from the OS. */
export interface LaunchPriorityPort {
  platform: NodeJS.Platform;
  /** Runs a program to completion; true when it started and exited 0. */
  succeeds(command: string, args: string[]): boolean;
}

/** Ships with macOS; `-a` execs the program in place (same pid) as an application. */
export const TASKPOLICY = "/usr/sbin/taskpolicy";

/**
 * How the desktop launches its daemon so the OS schedules it ahead of background work.
 *
 * macOS gives an unprivileged process no way to raise itself: `setpriority` with a negative
 * nice fails with EACCES and `posix_spawnattr_set_qos_class_np` only accepts lower classes.
 * Launched through `taskpolicy -a`, the daemon gets the scheduling policy macOS gives
 * applications: its main thread, which runs the event loop, starts at the user-interactive
 * QoS (priority 46 instead of 31). The CLIs the daemon starts keep the default. The wrapper
 * is used only once a dry run (`taskpolicy -a /usr/bin/true`) succeeded, so a system
 * without it still starts the daemon, unwrapped.
 *
 * Windows and Linux need nothing here: the daemon raises itself at start (its
 * `process-priority` module), which also covers a daemon started outside the app.
 *
 * Returns a function from the plain launch to the one to spawn. The dry run happens on the
 * first macOS launch and its answer is kept.
 */
export function daemonLaunchPolicy(port: LaunchPriorityPort): (launch: Launch) => Launch {
  let wrap: boolean | undefined;
  return (launch) => {
    if (port.platform !== "darwin") return launch;
    wrap ??= port.succeeds(TASKPOLICY, ["-a", "/usr/bin/true"]);
    return wrap ? { command: TASKPOLICY, args: ["-a", launch.command, ...launch.args] } : launch;
  };
}

/** The real OS, with a bounded dry run. */
export function systemLaunchPort(platform: NodeJS.Platform = process.platform): LaunchPriorityPort {
  return {
    platform,
    succeeds(command, args) {
      const result = spawnSync(command, args, { stdio: "ignore", timeout: 2_000 });
      return result.error === undefined && result.status === 0;
    },
  };
}
