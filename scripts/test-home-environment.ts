import { mkdirSync } from "node:fs";
import { isolatedTestEnvironment } from "./test-home-policy.ts";
import { assertTestHomeIsolation, parseTestEnvironment } from "@ace/provider-kit/test-isolation";

/** Shared by Vitest workers and the process project's fixture-building children. */
export function testHomeEnvironment(
  home: string,
  realHome: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  assertTestHomeIsolation(home, realHome);
  const env = isolatedTestEnvironment(parseTestEnvironment({ ...ambient }), home, realHome);
  for (const name of [
    "HOME",
    "ACE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
  ]) {
    const directory = env[name];
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return env;
}
