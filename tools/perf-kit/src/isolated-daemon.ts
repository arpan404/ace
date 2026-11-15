/**
 * Starts a bench daemon entry (such as apps/daemon/bench/slow-link-daemon.ts) as its own process in a fresh temporary home, with nothing of
 * the person's environment: HOME, every provider's config home and ACE_HOME point inside it,
 * PATH is empty so no provider CLI can be found, and the TLS listener for paired devices binds
 * with 127.0.0.1 as its advertised address. Requests go over IPC; the first message is the
 * entry's ready report. However the child ends (a crash on start included), `close()` returns
 * and the temporary home is removed.
 */
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BenchDaemon<Ready> {
  home: string;
  ready: Ready;
  request(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface BenchDaemonOptions<Ready> {
  entry: string;
  /** The runtime: the daemon's Bun (`bunBinary()` in scripts/runtimes.ts). */
  execPath: string;
  parse: (ready: unknown) => Ready;
  /** Added to, or replacing, the isolated environment. */
  env?: Record<string, string>;
  /** Where the temporary home is made; the system's temporary directory by default. */
  root?: string;
}

export async function startBenchDaemon<Ready>(
  options: BenchDaemonOptions<Ready>,
): Promise<BenchDaemon<Ready>> {
  const { entry, execPath, parse, env = {} } = options;
  const home = await mkdtemp(join(options.root ?? tmpdir(), "ace-slow-link-"));
  const child = fork(entry, [], {
    execPath,
    cwd: home,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      ACE_HOME: join(home, "daemon"),
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_WORKSPACE_ROOT: home,
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_PORT: "0",
      ACE_LISTEN: "lan",
      ACE_REMOTE_PORT: "0",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_LOG_LEVEL: "warn",
      ACE_MAINTENANCE: "0",
      ACE_DEV: "0",
      PATH: "",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  // Watched from the start, so a child that is already gone never leaves `close()` waiting.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_000);
  });
  const failed = Promise.withResolvers<never>();
  failed.promise.catch(() => undefined);
  let closing = false;
  child.on("exit", (code) => {
    if (!closing) failed.reject(new Error(`Bench daemon exited (${code}): ${stderr}`));
  });
  child.on("error", (error) => {
    if (!closing) failed.reject(new Error(`Bench daemon did not start: ${error.message}`));
  });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const first = Promise.withResolvers<unknown>();
  child.on("message", (input: unknown) => {
    if (typeof input !== "object" || input === null) return;
    const message = Object.fromEntries(Object.entries(input));
    if (typeof message["error"] === "string")
      return failed.reject(new Error(`${message["error"]}\n${stderr}`));
    const id = message["id"];
    if (id === 0) return first.resolve(input);
    if (typeof id !== "number") return;
    pending.get(id)?.(message);
    pending.delete(id);
  });
  let nextId = 0;
  let closed: Promise<void> | undefined;
  const close = () => {
    closing = true;
    closed ??= (async () => {
      try {
        const running = child.exitCode === null && child.signalCode === null;
        if (running && child.connected) child.send({ id: ++nextId, op: "close" });
        else if (running) child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        await exited;
        clearTimeout(timer);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    })();
    return closed;
  };
  try {
    const ready = parse(await Promise.race([first.promise, failed.promise]));
    return {
      home,
      ready,
      async request(data) {
        const id = ++nextId;
        const answer = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
        child.send({ id, ...data });
        return Promise.race([answer, failed.promise]);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
