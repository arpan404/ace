import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { bunBinary } from "../../../../scripts/runtimes.ts";
import { desktopDaemonEnvironment, desktopDaemonLayout } from "./daemon-environment.ts";

/**
 * The desktop e2e daemon's lifetime, on Bun with real processes: it refuses to start outside
 * the isolation its launcher builds, and it never outlives whoever holds its stdin.
 */
const program = fileURLToPath(new URL("./daemon-process.ts", import.meta.url));
const profile = JSON.stringify({ kind: "native" });
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-e2e-daemon-")));
  roots.push(root);
  await mkdir(join(root, "home"), { mode: 0o700 });
  return root;
}
const realHome = () => process.env.ACE_TEST_REAL_HOME ?? "/nonexistent";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the e2e daemon refuses a start that its launcher didn't isolate", async () => {
  const root = await fixtureRoot();
  // The caller's own environment: HOME is not the fixture root.
  const child = spawn(bunBinary(), [program, root, profile], {
    env: { ...process.env, BUN_OPTIONS: undefined },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = await once(child, "exit");
  expect(code).not.toBe(0);
  expect(stderr).toContain("which isolates it");
});

test("the e2e daemon exits when its stdin closes, even while it is still starting", async () => {
  const root = await fixtureRoot();
  const layout = desktopDaemonLayout(root);
  const child = spawn(bunBinary(), [program, root, profile], {
    env: desktopDaemonEnvironment(process.env, layout, realHome()),
    stdio: ["pipe", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin.end();
  const [code] = await once(child, "exit");
  expect(code).toBe(0);
  // It stopped before it was ever ready.
  expect(stdout).not.toContain("ready");
});

test("a running e2e daemon stops when the process that started it is killed", async () => {
  const root = await fixtureRoot();
  const client = fileURLToPath(new URL("./daemon-client.ts", import.meta.url));
  // A spec's process, reduced to starting the daemon and printing its pid.
  const spec = spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      `const { startDesktopDaemon } = await import(${JSON.stringify(client)});
const daemon = await startDesktopDaemon(${JSON.stringify(root)}, { kind: "native" });
process.stdout.write("pid " + daemon.pid + "\\n");
setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let stdout = "";
  const started = new Promise<number>((resolve, reject) => {
    spec.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const pid = /pid (\d+)/.exec(stdout)?.[1];
      if (pid) resolve(Number(pid));
    });
    spec.once("exit", (code) => reject(new Error(`The spec process exited (${code})`)));
  });
  const daemon = await started;
  expect(alive(daemon)).toBe(true);
  spec.kill("SIGKILL");
  await expect.poll(() => alive(daemon), { timeout: 15_000, interval: 100 }).toBe(false);
});
