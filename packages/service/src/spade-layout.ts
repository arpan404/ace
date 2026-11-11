import { dirname, join } from "node:path";
import { desktopAppMarker } from "./desktop-update.ts";
import { spadeBinaryName } from "./spade-plan.ts";

/**
 * Where a release carries `spade-server` (ADR 0123), the one definition packaging, the daemon
 * and the desktop app share. Both bundles keep it in a `spade` folder at their root:
 *
 * - a standalone release (`<ACE_HOME>/releases/<version>-<target>/`): `bin/node`, `ace.mjs`,
 *   `spade/spade-server`;
 * - the desktop app's resources: `runtime/` (Bun), `daemon/ace.mjs` beside the app's marker,
 *   `spade/spade-server`.
 */
export const spadeServerFolder = "spade";

/** `spade-server` (`.exe` on Windows) under a release or desktop resources `root`. */
export function bundledSpadeServer(root: string, platform: NodeJS.Platform): string {
  return join(root, spadeServerFolder, spadeBinaryName(platform));
}

/**
 * The root of the bundle a daemon entry script (`ace.mjs`) runs from: the desktop app's
 * resources, one folder above its `daemon` folder, when the app's marker sits beside the entry;
 * else the standalone release folder that holds the entry.
 */
export function bundleRootOfEntry(entry: string, exists: (path: string) => boolean): string {
  const folder = dirname(entry);
  return exists(join(folder, desktopAppMarker)) ? dirname(folder) : folder;
}
