import { join } from "node:path";

/**
 * Which screen helper this daemon runs. `ACE_SCREEN_HELPER` wins everywhere (the desktop app
 * points it at its bundled helper). On Linux a daemon started without the desktop app uses the
 * helper the release archive stages beside its entry bundle. Otherwise there is none, and the
 * daemon offers no screen tools.
 */
export function resolveScreenHelper(input: {
  platform: NodeJS.Platform;
  configured: string | undefined;
  /** The directory holding the running daemon's entry bundle. */
  bundleDirectory: string;
  exists: (path: string) => boolean;
}): string | undefined {
  if (input.configured) return input.configured;
  if (input.platform !== "linux") return undefined;
  const staged = join(input.bundleDirectory, "helpers", "ace-screen-helper-linux");
  return input.exists(staged) ? staged : undefined;
}

/**
 * The executable to start for a configured helper. On a Mac the desktop app names the helper's
 * `.app` bundle, which can't be started itself: the bundle is installed and its verified
 * executable returned, the same copy computer use runs. Any other path is already one.
 */
export function screenHelperExecutable(
  configured: string,
  install: (bundle: string) => Promise<string>,
): Promise<string> {
  const path = configured.replace(/\/+$/, "");
  return path.endsWith(".app") ? install(path) : Promise.resolve(configured);
}
