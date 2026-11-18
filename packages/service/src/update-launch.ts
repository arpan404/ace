import { homeServiceTag, taggedName } from "./service-name.ts";

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
 * also reports its real outcome. The unit is named for the home, as its services are (ADR 0185):
 * `ace-update` for the default home, `ace-update-<hash>` for any other, so two homes' updates
 * never collide while systemd still refuses a second update of the same home. Anywhere else (launchd, or Linux without a systemd user
 * session, such as a container or WSL), nothing kills a detached process with its parent.
 */
export function planUpdateLaunch(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The Node runtime and arguments that run the updater. */
  node: string;
  args: readonly string[];
  root: string;
  /** The person's home folder: its `.ace` is the default home. */
  userHome: string;
  /** Links resolved and names spelled as stored (`canonicalPath`), so one home has one unit. */
  canonical(path: string): string;
}): UpdateLaunch {
  const { platform, env, node, args, root } = options;
  if (platform !== "linux" || !env.INVOCATION_ID)
    return { command: node, args: [...args], detached: true };
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--wait",
      `--unit=${updateUnit(root, options.userHome, options.canonical)}`,
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

/** The transient unit the updater of `root` runs as. */
export function updateUnit(
  root: string,
  userHome: string,
  canonical: (path: string) => string,
): string {
  return taggedName(
    "ace-update",
    "-",
    homeServiceTag(canonical(root), canonical(userHome), "linux"),
  );
}
