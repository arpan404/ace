import { join } from "node:path";
import { isolatedTestEnvironment } from "../../../../scripts/test-home-policy.ts";

/**
 * Where a desktop e2e daemon lives, inside one temporary root the spec made: the person-level
 * home is the root itself (the Electron app gets the same HOME), the daemon's data is
 * `<root>/home`.
 */
export interface DesktopDaemonLayout {
  root: string;
  /** ACE_HOME: the daemon's data, and the home the app manages. */
  home: string;
}

export function desktopDaemonLayout(root: string): DesktopDaemonLayout {
  return { root, home: join(root, "home") };
}

/** Folders the environment points into; the launcher creates them before the daemon starts. */
export const environmentFolders = [
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

/**
 * The daemon process's whole environment: the shared test policy (every storage, provider and
 * Git selector redirected into the root, none inherited), the layout's ACE_HOME, and nothing a
 * caller's runtime flags could add. Bun applies BUN_OPTIONS (a --preload, say) to every Bun
 * process before its first line, so none may reach the daemon.
 */
export function desktopDaemonEnvironment(
  ambient: NodeJS.ProcessEnv,
  layout: DesktopDaemonLayout,
  realHome: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...isolatedTestEnvironment(ambient, layout.root, realHome),
    ACE_HOME: layout.home,
    ACE_ACCOUNTS_DB: join(layout.root, "accounts.sqlite"),
    ACE_LOG_LEVEL: "silent",
  };
  delete env.BUN_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * The Electron app's whole environment, beside that daemon: the same test policy, so the app
 * reads no storage or provider folder of the person's either, in managed mode on the layout's
 * ACE_HOME (where it adopts the running daemon), with its user data in the root. No
 * ELECTRON_RUN_AS_NODE survives: it would start Electron as plain Node.
 */
export function desktopAppEnvironment(
  ambient: NodeJS.ProcessEnv,
  layout: DesktopDaemonLayout,
  realHome: string,
): Record<string, string> {
  const env: NodeJS.ProcessEnv = {
    ...isolatedTestEnvironment(ambient, layout.root, realHome),
    ACE_HOME: layout.home,
    ACE_DESKTOP_USER_DATA: join(layout.root, "userData"),
    ACE_DESKTOP_DAEMON: "managed",
    ACE_DESKTOP_RENDERER_URL: "",
  };
  delete env.BUN_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  // Playwright takes set values only.
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) set[key] = value;
  return set;
}
