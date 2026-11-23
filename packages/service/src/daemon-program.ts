import { existsSync, linkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { daemonRuntimePath } from "./process-names.ts";

/**
 * The program that starts the daemon on the runtime at `runtime`, so it shows as `ace Service`
 * (`ace-service` on Linux) rather than as the runtime: the runtime's copy under that name when
 * the bundle carries one (the desktop app's), else a hard link to it beside it, made on first
 * start in a release ace installed (`<ACE_HOME>/releases/...`), whose archive holds only files
 * (the updaters of earlier releases accept no link entries). A link shares the runtime's bytes
 * and signature and costs no space. Anywhere ace may not add a file (a signed app bundle, a folder without links), the
 * daemon runs on the runtime as it is.
 */
export function startableDaemonRuntime(runtime: string, platform: NodeJS.Platform): string {
  const named = daemonRuntimePath(runtime, platform);
  if (existsSync(named)) return named;
  // `<ACE_HOME>/releases/<release>/bin/node`, beside its `release.json`: only a release ace
  // installed is ace's to add to (never a Homebrew keg, an npm package or an app bundle).
  const release = dirname(dirname(runtime));
  if (basename(dirname(release)) !== "releases" || !existsSync(join(release, "release.json")))
    return runtime;
  try {
    linkSync(runtime, named);
    return named;
  } catch {
    // Another start made it first, or this file system has no hard links.
    return existsSync(named) ? named : runtime;
  }
}
