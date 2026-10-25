import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Directories one benchmark owns; nothing outside them is read or written. */
export interface BenchRoot {
  home: string;
  aceHome: string;
  bin: string;
  project: string;
  tmp: string;
}
export interface DaemonSettings {
  /** Bundled CLI entry (`ace.mjs`). */
  entry: string;
  root: BenchRoot;
  fixtures: string;
  /** Recorded gaps are divided by this. */
  speed: number;
  /** Pause before each synthetic long-text delta. */
  deltaMs: number;
}
export interface RunningDaemon {
  pid: number;
  origin: string;
  token: string;
  inspectorUrl: string;
  stop(): Promise<void>;
}

/** A clean environment: nothing from the person's shell, their HOME or their ace data. */
export function daemonEnv(settings: DaemonSettings): NodeJS.ProcessEnv {
  const { home, aceHome, bin, tmp } = settings.root;
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    SHELL: "/bin/sh",
    TMPDIR: tmp,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    ACE_HOME: aceHome,
    ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_LOG_LEVEL: "warn",
    ACE_MAINTENANCE: "0",
    ACE_DEV: "0",
    ACE_HISTORY_INSTANCES: "[]",
    ACE_FAKE_CLI_FIXTURES: settings.fixtures,
    ACE_FAKE_CLI_SPEED: String(settings.speed),
    ACE_FAKE_CLI_DELTA_MS: String(settings.deltaMs),
  };
}

async function readWhenPresent(path: string, deadline: number, child: ChildProcess) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Daemon exited with ${child.exitCode}`);
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text) return text.trim();
    await pause(50);
  }
  throw new Error(`Daemon did not write ${path}`);
}

/** Starts `ace serve` with the inspector on a free port and waits for its endpoint. */
export async function startDaemon(settings: DaemonSettings): Promise<RunningDaemon> {
  const endpoint = join(settings.root.aceHome, "daemon-endpoint");
  await rm(endpoint, { force: true });
  const child = spawn(
    process.execPath,
    ["--inspect=127.0.0.1:0", "--no-warnings", settings.entry, "serve"],
    {
      cwd: dirname(settings.entry),
      env: daemonEnv(settings),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  const inspector = Promise.withResolvers<string>();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
    const url = /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1];
    if (url) inspector.resolve(url);
  });
  child.once("exit", (code) => inspector.reject(new Error(`Daemon exited ${code}: ${stderr}`)));
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + 60_000;
    const inspectorUrl = await inspector.promise;
    const origin = await readWhenPresent(endpoint, deadline, child);
    const token = await readWhenPresent(
      join(settings.root.aceHome, "daemon-token"),
      deadline,
      child,
    );
    return {
      pid: child.pid ?? 0,
      origin,
      token,
      inspectorUrl,
      async stop() {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        await exited;
        clearTimeout(timer);
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`Daemon start failed\n${stderr}`, { cause: error });
  }
}

/** macOS physical footprint (what Activity Monitor shows); undefined elsewhere. */
export async function footprint(pid: number): Promise<number | undefined> {
  if (process.platform !== "darwin") return undefined;
  const { stdout } = await run("/usr/bin/footprint", [
    "-p",
    String(pid),
    "-f",
    "bytes",
    "--noCategories",
  ]);
  const bytes = /phys_footprint:\s*(\d+)\s*B/.exec(stdout)?.[1];
  return bytes === undefined ? undefined : Number(bytes);
}
