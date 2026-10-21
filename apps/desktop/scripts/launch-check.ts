import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { launchVerdict } from "../src/packaging/launch-verdict.ts";

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
  env.ACE_HOME = join(scratch, "home");
  env.ACE_DESKTOP_USER_DATA = join(scratch, "electron");
  env.ACE_PORT = String(await freePort());
  const child = spawn(join(app, "Contents/MacOS/ace"), [], {
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
  } finally {
    // Quitting stops the daemon the app started; a stuck app is killed.
    child.kill("SIGTERM");
    const quit = setTimeout(() => child.kill("SIGKILL"), quitTimeoutMs);
    await exited;
    clearTimeout(quit);
    await rm(scratch, { recursive: true, force: true });
  }
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
