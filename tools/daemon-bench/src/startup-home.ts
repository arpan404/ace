/**
 * How long a daemon takes to start on a real home: spawn to the endpoint file (listening), and
 * spawn to a client's first loaded thread list (the sidebar). Every run reopens the same home,
 * as a desktop launch does.
 *
 * The home must be a copy (`cp -cR ~/.ace/dev /tmp/copy`): the daemon writes in it.
 *
 * bun tools/daemon-bench/src/startup-home.ts --home=DIR [--entry=apps/daemon/src/cli.ts]
 *   [--runtime=bun] [--reps=7] [--port=4391] [--prof=DIR]
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Client, webSocketTransport, type Storage } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { WebSocket } from "ws";

const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const home = resolve(option("home") ?? "");
if (!option("home") || resolve(home) === resolve(process.env.HOME ?? "", ".ace"))
  throw new Error("--home=<a copy of a home> is required");
const entry = resolve(option("entry") ?? "apps/daemon/src/cli.ts");
const runtime = option("runtime") ?? "bun";
const reps = Number(option("reps") ?? 7);
const port = Number(option("port") ?? 4391);
const prof = option("prof");

function memoryStorage(): Storage {
  let saved: string | null = null;
  return {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  };
}

async function waitFor<T>(read: () => T | undefined, deadlineMs: number): Promise<T> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error("Timed out");
    await pause(2);
  }
}

async function sidebar(origin: string, token: string) {
  const client = new Client({
    deviceId: DeviceId.parse("startup-bench"),
    transport: () => webSocketTransport(() => new WebSocket(origin.replace("http:", "ws:"))),
    credential: async () => token,
    storage: memoryStorage(),
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    random: Math.random,
    id: randomUUID,
    now: Date.now,
  });
  const lease = client.threads();
  await client.start();
  const selection = lease.store.select(["ids"], (store) =>
    store.loaded && !store.syncing ? store.ids.length : undefined,
  );
  const rows = await new Promise<number>((done) => {
    const check = () => {
      const value = selection.getSnapshot();
      if (value !== undefined) done(value);
    };
    selection.subscribe(check);
    check();
  });
  lease.release();
  return { rows, close: () => client.close() };
}

async function once(execArgv: string[]) {
  const endpoint = join(home, "daemon-endpoint");
  rmSync(endpoint, { force: true });
  const started = performance.now();
  const child = spawn(runtime, [...execArgv, entry, "start"], {
    env: { ...process.env, ACE_HOME: home, ACE_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    const origin = await waitFor(
      () => (existsSync(endpoint) ? readFileSync(endpoint, "utf8").trim() || undefined : undefined),
      30_000,
    ).catch((error: unknown) => {
      throw new Error(`No endpoint: ${stderr.slice(-2000)}`, { cause: error });
    });
    const listeningMs = performance.now() - started;
    const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
    const { rows, close } = await sidebar(origin, token);
    const sidebarMs = performance.now() - started;
    close();
    return { listeningMs, sidebarMs, rows, load: loadavg()[0] ?? 0 };
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
// One unmeasured start warms the file cache and settles anything a first start records.
await once([]);
const runs = [];
for (let rep = 0; rep < reps; rep++) runs.push(await once([]));
const result: Record<string, unknown> = {
  entry,
  runtime,
  listeningMedianMs: Math.round(median(runs.map((run) => run.listeningMs))),
  sidebarMedianMs: Math.round(median(runs.map((run) => run.sidebarMs))),
  rows: runs[0]?.rows,
  load: runs.map((run) => Number(run.load.toFixed(2))),
  runs: runs.map((run) => [Math.round(run.listeningMs), Math.round(run.sidebarMs)]),
};
if (prof) {
  result["profiled"] = await once([
    "--cpu-prof",
    "--cpu-prof-interval=200",
    `--cpu-prof-dir=${resolve(prof)}`,
  ]);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
