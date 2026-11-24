import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { bunBinary } from "../../../scripts/runtimes.ts";

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

/** A native switch the caller may set, and the addon variables its shell loads (ADR 0222-0226). */
interface SwitchRow {
  readonly variable: string;
  /** The addon paths it needs, each one an absolute path to an existing file. */
  readonly addons: readonly string[];
  /** Why a set switch has no usable addon: the shell that loads one does not exist yet. */
  readonly absent?: string;
}

/**
 * The native switches and the addon each one loads. The bench bundles the daemon into a temporary
 * directory, so the development-build path a shell would resolve from its own file
 * (`native/daemon/target/release/…`, three levels up) does not exist there: a set switch needs its
 * addon named absolutely, and the bench refuses to start rather than measure the other backend.
 */
const switchRows: readonly SwitchRow[] = [
  { variable: "ACE_STORE", addons: ["ACE_STORE_ADDON"] },
  // The bench sets the supervisor's addon explicitly: the shell falls back to the store's.
  { variable: "ACE_SUPERVISOR", addons: ["ACE_SUPERVISOR_ADDON"] },
  // The Codex, Claude, Cursor and ACP shells read only the store's addon; OpenCode reads only
  // ACE_TRANSLATORS_ADDON, and Pi reads it first, then the store's.
  { variable: "ACE_TRANSLATORS", addons: ["ACE_STORE_ADDON", "ACE_TRANSLATORS_ADDON"] },
  {
    variable: "ACE_SESSIONS",
    addons: [],
    absent:
      "the daemon bench's only provider is claude, which has no native session; measure sessions with apps/daemon/bench/session-stream.ts",
  },
  {
    variable: "ACE_ENGINE",
    addons: [],
    absent: "no shell loads an engine addon yet",
  },
  {
    variable: "ACE_CORE",
    addons: [],
    absent:
      "the core's native loader is a placeholder, and the wasm build is never loaded by the daemon",
  },
  { variable: "ACE_GIT", addons: ["ACE_GIT_ADDON"] },
  // The bench sets the transport's addon explicitly: its shell falls back to the store's.
  { variable: "ACE_TRANSPORT", addons: ["ACE_TRANSPORT_ADDON"] },
];

/**
 * The names forwarded from the bench's own environment. `ACE_STORE_READS` is a switch too, but it
 * selects reads from the store's addon rather than loading one, and it refuses without
 * `ACE_STORE=native`; the evidence path is where the bundled daemon writes what the bench reads.
 */
const switchVariables: readonly string[] = [
  ...new Set([
    ...switchRows.map((row) => row.variable),
    ...switchRows.flatMap((row) => row.addons),
    "ACE_STORE_READS",
    "ACE_TRANSPORT_EVIDENCE",
  ]),
];

/** Refuses `variable` unless it is an absolute path to a regular file. */
function requireAddon(variable: string, because: string): void {
  const value = process.env[variable];
  if (value === undefined || value === "")
    throw new Error(`${because} but ${variable} is unset or empty`);
  if (!isAbsolute(value)) throw new Error(`${because} but ${variable} is relative: ${value}`);
  const stats = statSync(value, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile())
    throw new Error(`${because} but ${variable} names no regular file: ${value}`);
}

/** Refuses a switch the bench cannot run honestly, before it starts or measures anything. */
function checkSwitches(): void {
  for (const row of switchRows) {
    const value = process.env[row.variable];
    if (value === undefined || value === "") continue;
    const because = `${row.variable}=${value} is set in the bench's environment`;
    if (row.absent !== undefined) throw new Error(`${because}, but ${row.absent}`);
    for (const addon of row.addons) requireAddon(addon, `${because} and needs ${addon}`);
  }
}

/**
 * The switches and addon paths from the bench's own environment, so one benchmark can measure the
 * same workload on each backend. Everything else stays the clean environment below.
 */
function switches(): NodeJS.ProcessEnv {
  const passed: NodeJS.ProcessEnv = {};
  for (const name of switchVariables) {
    const value = process.env[name];
    if (value !== undefined) passed[name] = value;
  }
  return passed;
}

/**
 * A clean environment: nothing from the person's shell, their HOME or their ace data, except the
 * native switches and addon paths above, which a run must set to measure a backend.
 */
export function daemonEnv(settings: DaemonSettings): NodeJS.ProcessEnv {
  checkSwitches();
  const { home, aceHome, bin, tmp } = settings.root;
  return {
    ...switches(),
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

/**
 * Starts `ace serve` on Bun, the daemon's runtime, with the inspector on a free port and waits
 * for its endpoint.
 */
export async function startDaemon(settings: DaemonSettings): Promise<RunningDaemon> {
  const endpoint = join(settings.root.aceHome, "daemon-endpoint");
  await rm(endpoint, { force: true });
  const child = spawn(
    bunBinary(),
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
    // Node prints "Debugger listening on ws://…"; Bun prints "Listening:" and the URL below it.
    const url = /(?:Debugger listening on|Listening:)\s+(ws:\/\/\S+)/.exec(stderr)?.[1];
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
