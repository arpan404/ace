import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { workerPreloadVariable } from "@ace/provider-kit/worker";
import { threadCensus } from "./threads.ts";

/**
 * Source entry keeps dependency names visible; bundled RSS is checked separately. The daemon
 * runs on Bun, and its first start in a fresh HOME transpiles every source file, so startup
 * gets more room than a warm start needs.
 */
export async function checkIdleImports(
  options: {
    /** The program to watch: the source benchmark daemon unless a test names a stand-in. */
    entry?: string;
    args?: string[];
    /** How long it idles before the check: background initialization and worker retirement. */
    settleMs?: number;
  } = {},
): Promise<void> {
  const { entry = join(import.meta.dirname, "entry.ts"), args = [], settleMs = 7000 } = options;
  const directory = await mkdtemp(join(tmpdir(), "ace-idle-imports-"));
  // The daemon may rename an unversioned data home on startup. Keep the guard's
  // output outside that home so the import hook and the reader share one path.
  const home = join(directory, "daemon");
  const output = join(directory, "imports.log");
  const isolates = join(directory, "isolates.log");
  await writeFile(output, "");
  await writeFile(isolates, "");
  const hook = join(import.meta.dirname, "idle-import-hook.ts");
  const child = fork(entry, args, {
    // The hook is a Bun preload: the guard watches the daemon on its own runtime, in its main
    // isolate and in every worker ace starts.
    execPath: bunBinary(),
    execArgv: ["--preload", hook],
    env: {
      ...process.env,
      BUN_OPTIONS: undefined,
      HOME: directory,
      USERPROFILE: directory,
      ACE_HOME: home,
      ACE_WORKSPACE_ROOT: home,
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_RELAY_URL: undefined,
      ACE_IDLE_IMPORT_LOG: output,
      ACE_IDLE_IMPORT_ISOLATES: isolates,
      [workerPreloadVariable]: hook,
      PATH: "",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16000);
  });
  const exited = once(child, "exit");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const started = performance.now();
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Idle import daemon exited: ${stderr}`);
      try {
        await readFile(join(home, "daemon-endpoint"), "utf8");
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (performance.now() - started > 30000)
        throw new Error(`Idle import startup timed out: ${stderr}`);
      await pause(25);
    }
    // Include background feature initialization and the idle worker retirement interval.
    await pause(settleMs);
    if (!child.connected) throw new Error(`Idle import daemon disconnected: ${stderr}`);
    const pid = child.pid;
    if (pid === undefined) throw new Error("Idle import daemon has no process");
    const running = (await threadCensus(pid)).workers;
    child.send({ id: 1, op: "close" });
    const [code, signal] = await exited;
    if (code !== 0 || signal) throw new Error(`Idle import shutdown failed: ${stderr}`);
    const violations = [...new Set((await readFile(output, "utf8")).trim().split("\n"))].filter(
      Boolean,
    );
    if (violations.length) throw new Error(`Modules loaded at idle:\n${violations.join("\n")}`);
    // The main isolate is thread 0; any other id is a worker the hook ran in.
    const watched = new Set(
      (await readFile(isolates, "utf8")).split("\n").filter((id) => id && id !== "0"),
    );
    if (running > 0 && watched.size === 0)
      throw new Error(
        `Idle imports in workers: not measured (${running} running, the hook ran in none)`,
      );
    process.stdout.write(
      `Idle import guard passed in the main isolate and ${watched.size} worker(s)\n`,
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) await checkIdleImports();
