import { spawn } from "node:child_process";

/** A program and its arguments, as handed to `spawn`. */
export interface Launch {
  command: string;
  args: string[];
}

/** What the launch policy needs from the OS. */
export interface LaunchPriorityPort {
  platform: NodeJS.Platform;
  /** Runs a program to completion; true when it started and exited 0. */
  succeeds(command: string, args: string[]): Promise<boolean>;
}

/** How the daemon is launched, once its dry run (if any) has answered. */
export interface LaunchPolicy {
  /** Settles once the dry run answered; started by the first call and kept after. */
  ready(): Promise<void>;
  /** The launch to spawn. Before `ready` settles it is the plain launch. */
  wrap(launch: Launch): Launch;
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
 * The dry run runs once, off the main thread's critical path (the supervisor awaits `ready`
 * only on its way to a spawn), and its answer is kept for later restarts.
 */
export function daemonLaunchPolicy(port: LaunchPriorityPort): LaunchPolicy {
  let wrapped = false;
  let checking: Promise<void> | undefined;
  return {
    ready() {
      if (port.platform !== "darwin") return Promise.resolve();
      return (checking ??= port.succeeds(TASKPOLICY, ["-a", "/usr/bin/true"]).then(
        (ok) => void (wrapped = ok),
        () => undefined,
      ));
    },
    wrap: (launch) =>
      wrapped ? { command: TASKPOLICY, args: ["-a", launch.command, ...launch.args] } : launch,
  };
}

/** The real OS, with a bounded dry run. */
export function systemLaunchPort(platform: NodeJS.Platform = process.platform): LaunchPriorityPort {
  return {
    platform,
    succeeds(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "ignore", timeout: 2_000 });
        child.once("error", () => resolve(false));
        child.once("exit", (code) => resolve(code === 0));
      });
    },
  };
}
