import { execFile } from "node:child_process";
import { promisify } from "node:util";

/*
 * `vite build` of apps/web for the browser runs. Vitest sets NODE_ENV=test, and Vite builds with
 * whatever NODE_ENV it is given, so a build started from a test inherits "test" and ships React's
 * development code: StrictMode mounts every effect twice and every render runs dev checks, which
 * neither a person nor a budget ever sees. The build is always a production one.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;

/** Builds apps/web with `args` (`--outDir`, `--mode`) as a production build. */
export async function viteBuild(args: readonly string[]): Promise<void> {
  await promisify(execFile)("bunx", ["vite", "build", ...args], {
    cwd: web,
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 64 * 1024 * 1024,
  });
}
