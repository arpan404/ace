import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { TimingFailure } from "@ace/perf-kit";

const Sample = z.object({
  id: z.number(),
  at: z.number(),
  cpu: z.object({ user: z.number().nonnegative(), system: z.number().nonnegative() }),
  memory: z.object({ rss: z.number().nonnegative() }),
});
const Ack = z.object({ id: z.number(), memory: z.object({ rss: z.number() }) });

/** Process-wide CPU includes worker isolates. No measurement polling in the daemon. */
export async function measureIdleCpu(entry: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-cpu-"));
  let stderr = "";
  let expectedExit = false;
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => {});
  const launch = () => {
    const child = fork(entry, [], {
      execArgv: [],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: "",
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        ACE_HOME: home,
        ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
        ACE_CURSOR_SDK_HOME: undefined,
        ACE_SCREEN_HELPER: undefined,
        ACE_SCREEN_HELPER_MANIFEST: undefined,
        ACE_PERF_TELEMETRY: undefined,
        NODE_OPTIONS: undefined,
        ACE_WORKSPACE_ROOT: home,
        ACE_MODEL_INSTANCES: "[]",
        ACE_HISTORY_INSTANCES: "[]",
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_LOG_LEVEL: "silent",
        ACE_RELAY_URL: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const ready = once(child, "message");
    const exited = once(child, "exit");
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("exit", () => {
      if (!expectedExit) failed.reject(new Error(`Idle CPU daemon exited: ${stderr}`));
    });
    return { child, ready, exited };
  };
  let { child, ready, exited } = launch();
  const deadline = setTimeout(
    () => failed.reject(new TimingFailure(`Idle CPU measurement timed out: ${stderr}`)),
    180_000,
  );
  let id = 0;
  const request = async (op: "idle-store" | "idle-sample") => {
    const response = once(child, "message");
    child.send({ id: ++id, op });
    const [value] = await Promise.race([response, failed.promise]);
    if (Ack.parse(value).id !== id) throw new Error("Uncorrelated idle CPU response");
    return value;
  };
  try {
    const [greeting] = await Promise.race([ready, failed.promise]);
    if (Ack.parse(greeting).id !== 0) throw new Error("Missing idle CPU readiness acknowledgment");
    await request("idle-store");
    // Reopen the persisted store as on a normal daemon launch. Seeding allocation
    // and the synthetic frame replay are outside the measured daemon lifetime.
    expectedExit = true;
    child.send({ id: ++id, op: "close" });
    const [seedCode, seedSignal] = await Promise.race([exited, failed.promise]);
    if (seedCode !== 0 || seedSignal) throw new Error(`Idle store seeding failed: ${stderr}`);
    expectedExit = false;
    ({ child, ready, exited } = launch());
    const [restarted] = await Promise.race([ready, failed.promise]);
    if (Ack.parse(restarted).id !== 0) throw new Error("Missing restarted daemon acknowledgment");
    // Completed sessions, 16,000 stream deltas, indexes and timers have time to settle.
    await Promise.race([pause(10_000), failed.promise]);
    const start = Sample.parse(await request("idle-sample"));
    await Promise.race([pause(60_000), failed.promise]);
    const end = Sample.parse(await request("idle-sample"));
    const elapsedMs = end.at - start.at;
    const cpuPercent =
      (end.cpu.user + end.cpu.system - start.cpu.user - start.cpu.system) / elapsedMs / 10;
    const result = { cpuPercent, elapsedMs, rss: end.memory.rss, threads: 16, deltas: 16_000 };
    expectedExit = true;
    child.send({ id: ++id, op: "close" });
    const [code, signal] = await Promise.race([exited, failed.promise]);
    if (code !== 0 || signal) throw new Error(`Idle CPU shutdown failed: ${stderr}`);
    process.stdout.write(`Daemon idle CPU: ${JSON.stringify(result)}\n`);
    return result;
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}
if (process.argv[1] === import.meta.filename)
  await measureIdleCpu(process.argv[2] ?? join(import.meta.dirname, "entry.ts"));
