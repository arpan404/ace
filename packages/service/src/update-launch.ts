/** How the supervisor starts the external updater (`ace update apply|recover`). */
export interface UpdateLaunch {
  command: string;
  args: string[];
  /** Start it in its own process group, so it outlives the supervisor's exit. */
  detached: boolean;
}

/**
 * The updater stops the service that started it, so it must not live in that service's
 * process tree. Under systemd (the user unit sets `INVOCATION_ID`), stopping ace's unit kills
 * its whole cgroup, so the updater runs as its own transient unit: `systemd-run --user --wait`
 * also reports its real outcome. Anywhere else (launchd, or Linux without a systemd user
 * session, such as a container or WSL), nothing kills a detached process with its parent.
 */
export function planUpdateLaunch(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The Node runtime and arguments that run the updater. */
  node: string;
  args: readonly string[];
  root: string;
}): UpdateLaunch {
  const { platform, env, node, args, root } = options;
  if (platform !== "linux" || !env.INVOCATION_ID)
    return { command: node, args: [...args], detached: true };
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--wait",
      "--unit=ace-update",
      "--collect",
      "--property=RuntimeMaxSec=1800",
      `--setenv=ACE_HOME=${root}`,
      `--setenv=PATH=${env.PATH ?? "/usr/bin:/bin"}`,
      "--",
      node,
      ...args,
    ],
    detached: false,
  };
}
