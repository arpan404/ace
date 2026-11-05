import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Finding the two runtimes the repository's tooling uses: Bun, which runs the daemon, and Node,
 * which runs what Bun can't (the Node pass of a test run, Playwright, Electron's tooling).
 */

/** The first executable called `name` on PATH that reports `runtime` when asked. */
function onPath(name: string, runtime: "bun" | "node", path: string): string | undefined {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, file);
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ["-e", "process.stdout.write(process.versions.bun ? 'bun' : 'node')"],
      { encoding: "utf8" },
    );
    if (probe.status === 0 && probe.stdout === runtime) return candidate;
  }
  return undefined;
}

/**
 * The first `node` on PATH that is Node itself. Bun's node shim and ace's own bin/node are Bun,
 * and a Node pass exists to run what Bun can't.
 */
export function realNode(path = process.env.PATH ?? ""): string | undefined {
  return onPath("node", "node", path);
}

/**
 * The Bun to start the daemon with: this process's own runtime when it is Bun, otherwise the
 * first `bun` on PATH. The daemon uses Bun-only APIs (bun:ffi, Bun.Image, Bun's PTY) and can't
 * start on Node, so tooling that runs on Node must hand the daemon to Bun.
 */
export function bunBinary(path = process.env.PATH ?? ""): string {
  if (process.versions.bun) return process.execPath;
  const bun = onPath("bun", "bun", path);
  if (bun) return bun;
  throw new Error(
    "The ace daemon runs on Bun, and no `bun` was found on PATH. Install the version package.json's packageManager names (https://bun.com) or put it on PATH.",
  );
}
