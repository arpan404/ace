import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { shippedExecutableName } from "@ace/service/process-names";
import { launchVerdict } from "../src/packaging/launch-verdict.ts";
import { e2eSwitches } from "./common.ts";

const launchTimeoutMs = 90_000;
const quitTimeoutMs = 20_000;

/**
 * Launches the packaged app the way a person would, with its own empty data home, port and
 * Electron profile so it never touches the ace on this Mac, and waits for the daemon and the
 * first update check (see `launchVerdict`). Paths that only run packaged, like the updater,
 * are covered nowhere else.
 */
export async function checkPackagedLaunch(app: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "ace-launch-check-"));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("ACE_") && !key.startsWith("ELECTRON_")) env[key] = value;
  const home = join(scratch, "home");
  env.ACE_HOME = home;
  env.ACE_DESKTOP_USER_DATA = join(scratch, "electron");
  env.ACE_PORT = String(await freePort());
  const child = spawn(join(app, "Contents/MacOS/ace"), e2eSwitches(process.platform), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const lines: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const verdict = launchVerdict(lines);
        const missing = verdict.state === "waiting" ? verdict.missing.join(" and ") : "";
        reject(new Error(`The packaged app never showed ${missing}:\n${lines.join("\n")}`));
      }, launchTimeoutMs);
      const settle = () => {
        const verdict = launchVerdict(lines);
        if (verdict.state === "waiting") return;
        clearTimeout(timer);
        if (verdict.state === "passed") resolve();
        else reject(new Error(`The packaged app failed to start: ${verdict.reason}`));
      };
      for (const stream of [child.stdout, child.stderr])
        createInterface({ input: stream }).on("line", (line) => {
          lines.push(line);
          settle();
        });
      void exited.then(() => {
        clearTimeout(timer);
        reject(new Error(`The packaged app exited during launch:\n${lines.join("\n")}`));
      });
    });
    assertDaemonName(home);
  } finally {
    // A stuck app is killed. Its daemon outlives it (ADR 0186), so it is stopped next.
    child.kill("SIGTERM");
    const quit = setTimeout(() => child.kill("SIGKILL"), quitTimeoutMs);
    await exited;
    clearTimeout(quit);
    stopDaemon(env);
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The app's daemon must show as `ace Service` in Activity Monitor, not as the runtime it runs on:
 * the pid in the home's lock runs the runtime's `ace Service` copy.
 */
function assertDaemonName(home: string): void {
  const lock = z
    .object({ pid: z.number().int().positive() })
    .parse(JSON.parse(readFileSync(join(home, "daemon-lock"), "utf8")));
  const ps = spawnSync("ps", ["-o", "comm=", "-p", String(lock.pid)], { encoding: "utf8" });
  const name = basename(ps.stdout.trim());
  const expected = shippedExecutableName("daemon", "darwin");
  if (name !== expected)
    throw new Error(`The packaged app's daemon runs as ${JSON.stringify(name)}, not ${expected}`);
}

/** Stops the daemon the check's app left running, with the `ace` command the app wrote. */
function stopDaemon(env: NodeJS.ProcessEnv): void {
  const ace = join(env.ACE_HOME ?? "", "bin", "ace");
  if (!existsSync(ace)) return;
  const stop = spawnSync(ace, ["stop"], { env, encoding: "utf8", timeout: quitTimeoutMs });
  if (stop.status !== 0)
    console.warn(
      `The launch check's daemon may still be running (ace stop: ${stop.error?.message ?? (stop.stderr || stop.stdout).trim()})`,
    );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port for the launch check")),
      );
    });
  });
}
