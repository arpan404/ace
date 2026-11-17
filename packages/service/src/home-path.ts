import { join, resolve } from "node:path";
import { assertTestHomeIsolation } from "./test-home-guard.ts";

/**
 * The ace data home: `ACE_HOME` when set, otherwise `~/.ace` (ADR 0081). This only names the
 * path. Whatever writes into the home first runs `prepareDaemonHome`, which creates it or gives
 * it a fresh start. `~/.ace-next`, used by interim builds, is never read. Its own module, light
 * to load, so the CLI can find the home before it loads the rest of ace (ADR 0176 §9).
 */
export function resolveDaemonHome(home: string, requested?: string): string {
  assertTestHomeIsolation(home);
  const root = requested === undefined ? join(resolve(home), ".ace") : resolve(requested);
  assertTestHomeIsolation(root);
  return root;
}
