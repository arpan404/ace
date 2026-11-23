import { isAbsolute } from "node:path";

/**
 * The folder ace was started from, handed to the daemon by the launchers that start Bun in the
 * daemon's own folder (`ace open`, the release supervisor). Bun reads `.env` and `bunfig.toml`
 * from its working directory at start (ADR 0214), so it must not start in a project folder; the
 * daemon goes back to this one before any of its code runs, which keeps every relative setting,
 * model-instance folder and child's working directory meaning what it did.
 */
export const launchDirectoryVariable = "ACE_LAUNCH_CWD";

/**
 * Moves the process into the launch folder named in `env` and removes the variable, so no child
 * inherits it. A folder that is missing, relative or refused leaves the process where it is.
 */
export function returnToLaunchDirectory(
  env: NodeJS.ProcessEnv,
  ports: { chdir(path: string): void; isDirectory(path: string): boolean },
): "returned" | "stayed" | "unset" {
  const folder = env[launchDirectoryVariable];
  delete env[launchDirectoryVariable];
  if (!folder) return "unset";
  if (!isAbsolute(folder) || !ports.isDirectory(folder)) return "stayed";
  try {
    ports.chdir(folder);
    return "returned";
  } catch {
    return "stayed";
  }
}
