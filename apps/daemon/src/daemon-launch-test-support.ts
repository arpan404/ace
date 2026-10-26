import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLogRecords, type DaemonLogRecord } from "./daemon-log-test-support.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const daemonPackage = fileURLToPath(new URL("../", import.meta.url));
export type Cleanups = (() => Promise<void> | void)[];

export async function temporaryHome(prefix: string, cleanups: Cleanups): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 10 }));
  return home;
}

/** No provider CLI, account, push key or maintenance pass is reachable from these daemons. */
export function daemonEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ACE_HOME: home,
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_MAINTENANCE: "0",
    ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
    ACE_DEV: "0",
    ACE_HISTORY_INSTANCES: "[]",
    ACE_MODEL_INSTANCES: "[]",
    ACE_APNS_KEY_FILE: "",
    ACE_VAPID_KEY_FILE: "",
    ACE_WORKSPACE_ROOT: "",
    ACE_RELAY_URL: undefined,
    ACE_SCREEN_HELPER: undefined,
    PATH: "",
  };
}

/** `ace start` from source; readiness is the CLI's own "Token file:" line. */
export function startDaemonCli(home: string, cleanups: Cleanups, preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), cli, "start"], {
    cwd: daemonPackage,
    env: daemonEnv(home),
    stdio: preload ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Token file:")) resolve();
    });
    void exited.then((code) => reject(new Error(`Daemon exited ${code} before ready: ${errors}`)));
  });
  ready.catch(() => {});
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, ready, exited, errors: () => errors };
}

/** The daemon's own account of how its previous run ended. */
export async function lastRunEnding(home: string): Promise<DaemonLogRecord | undefined> {
  return (await daemonLogRecords(home)).findLast((record) =>
    /^(No previous daemon run|Previous daemon run)/.test(record.message),
  );
}

/** Bytes still waiting in a database's write-ahead log; a missing log counts as drained. */
export async function walBytes(database: string): Promise<number> {
  try {
    return (await stat(`${database}-wal`)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export { cli as daemonCliSource, daemonPackage };
