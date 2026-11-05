import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { daemonHome, projectsRoot } from "./real-daemon-config.ts";
import { assertRealDaemonEnvironment, realDaemonEnvironment } from "./real-daemon-environment.ts";

/**
 * Starts the e2e daemon (real-daemon.ts) on Bun, the daemon's runtime, from Node or Bun. Inherited
 * storage and provider selectors are replaced before that process starts, so everything in it,
 * os.homedir() included, sees only the fixture home. Signals pass through, and the launcher
 * exits as the daemon does.
 */
const env: NodeJS.ProcessEnv = {
  ...realDaemonEnvironment(process.env, daemonHome, process.env.ACE_TEST_REAL_HOME ?? homedir()),
  ACE_E2E_DAEMON_PATH: daemonHome,
  ACE_E2E_PROJECTS_PATH: projectsRoot,
};
await assertRealDaemonEnvironment(env, daemonHome);
const daemon = spawn(bunBinary(), [fileURLToPath(new URL("./real-daemon.ts", import.meta.url))], {
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => daemon.kill(signal));
daemon.once("error", (error) => {
  console.error(`Could not start the e2e daemon: ${error.message}`);
  process.exit(1);
});
daemon.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
