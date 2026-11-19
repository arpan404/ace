import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { layout } from "./real-daemon-config.ts";
import { assertRealDaemonEnvironment, realDaemonEnvironment } from "./real-daemon-environment.ts";
import { prepareFixtureRoot } from "./real-daemon-layout.ts";

/**
 * Starts the e2e daemon (real-daemon.ts) on Bun, the daemon's runtime, from Node or Bun. Inherited
 * storage and provider selectors are replaced before that process starts, so everything in it,
 * os.homedir() included, sees only the fixture home. Signals pass through, and the launcher
 * exits as the daemon does.
 */

// The daemon deletes and rebuilds its folders on every start, so where they are is never taken
// from the environment: a path exported for something else must not become a deletion target.
const inherited = Object.keys(process.env).filter((key) =>
  /^ACE_E2E_\w*(?:PATH|ROOT|DIR)$/.test(key),
);
if (inherited.length > 0) {
  console.error(
    `The e2e launcher places its fixtures in ${layout.root} and takes no paths from the environment; unset ${inherited.join(", ")}`,
  );
  process.exit(1);
}
prepareFixtureRoot(layout);
const env = realDaemonEnvironment(
  process.env,
  layout.daemonHome,
  process.env.ACE_TEST_REAL_HOME ?? homedir(),
);
await assertRealDaemonEnvironment(env, layout.daemonHome);
// The daemon's layout travels in its arguments, which no environment can supply.
const daemon = spawn(
  bunBinary(),
  [fileURLToPath(new URL("./real-daemon.ts", import.meta.url)), layout.tmpRoot, layout.name],
  // Its stdin is a pipe only this process holds: it closes when the launcher dies, however it
  // dies, and the daemon stops with it.
  { env, stdio: ["pipe", "inherit", "inherit"] },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => daemon.kill(signal));
daemon.once("error", (error) => {
  console.error(`Could not start the e2e daemon: ${error.message}`);
  process.exit(1);
});
daemon.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
