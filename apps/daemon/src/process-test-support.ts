import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

export const daemonCli = () => inject("daemonCli");
export const tlsFixtureHome = () => inject("tlsHome");

/** Each daemon gets private writable files; only signing is shared. */
export function copyTlsFixture(home: string): void {
  cpSync(join(tlsFixtureHome(), "tls"), join(home, "tls"), { recursive: true });
}

/** Readiness comes from the CLI's output; an early exit rejects with stderr. */
export function launchDaemon(
  env: NodeJS.ProcessEnv,
  readiness: RegExp,
  cleanups: (() => Promise<void> | void)[],
) {
  const child = spawn(process.execPath, [daemonCli(), "start"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ACE_HISTORY_INSTANCES: "[]", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const ready = new Promise<string>((resolve) => {
    child.stdout.on("data", (data) => {
      output += String(data);
      if (readiness.test(output)) resolve(output);
    });
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child,
    exited,
    ready: Promise.race([
      ready,
      exited.then(() => {
        throw new Error(`Daemon exited before ready: ${errors}`);
      }),
    ]),
  };
}
