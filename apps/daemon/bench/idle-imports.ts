import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

/** Source entry keeps dependency names visible; bundled RSS is checked separately. */
export async function checkIdleImports(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-imports-"));
  const output = join(home, "imports.log");
  await writeFile(output, "");
  const child = fork(join(import.meta.dirname, "entry.ts"), [], {
    execArgv: ["--import", join(import.meta.dirname, "idle-import-hook.ts")],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ACE_HOME: home,
      ACE_WORKSPACE_ROOT: home,
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_RELAY_URL: undefined,
      ACE_IDLE_IMPORT_LOG: output,
      PATH: "",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16000);
  });
  const exited = once(child, "exit");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20000);
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
      if (performance.now() - started > 10000) throw new Error("Idle import startup timed out");
      await pause(25);
    }
    // Include background feature initialization and the idle worker retirement interval.
    await pause(7000);
    if (!child.connected) throw new Error(`Idle import daemon disconnected: ${stderr}`);
    child.send({ id: 1, op: "close" });
    const [code, signal] = await exited;
    if (code !== 0 || signal) throw new Error(`Idle import shutdown failed: ${stderr}`);
    const violations = [...new Set((await readFile(output, "utf8")).trim().split("\n"))].filter(
      Boolean,
    );
    if (violations.length) throw new Error(`Modules loaded at idle:\n${violations.join("\n")}`);
    process.stdout.write("Idle import guard passed in the main isolate and startup workers\n");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) await checkIdleImports();
