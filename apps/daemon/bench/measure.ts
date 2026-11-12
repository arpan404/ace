import { writeSync } from "node:fs";
import { fork, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";
import { readWorkerSnapshot, measureWithCleanup, TimingFailure } from "@ace/perf-kit";
import { Telemetry, Response } from "./telemetry-schema.ts";
import { writeMeasurement } from "./output.ts";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { workerPreloadVariable } from "@ace/provider-kit/worker";
import { threadCensus } from "./threads.ts";
import { observedWorkers, settledWorkerViolations } from "./budgets.ts";
import { soakReader } from "./soak-reader.ts";

const run = promisify(execFile);
const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const idleOnly = process.argv.includes("--idle-only");
const historyFixture = argument("history-instances", "");
const historyInstances = historyFixture ? await readFile(resolve(historyFixture), "utf8") : "[]";
const idleMs = z.coerce.number().int().min(3000).parse(argument("idle-ms", "60000"));
const count = z.coerce.number().int().min(1).max(64).parse(argument("sessions", "16"));
const events = z.coerce.number().int().min(100).max(100000).parse(argument("events", "1000"));
const soakMs = z.coerce.number().int().min(0).parse(argument("soak-ms", "10000"));
const collect = process.argv.includes("--collect");
const collectWorkers = process.argv.includes("--collect-workers");
if (collectWorkers && !collect) throw new Error("Worker collection requires --collect");
const freshCycles = process.argv.includes("--fresh-cycles");
/** A client keeps the thread list open and opens every cycled thread, as the desktop would. */
const subscribeCycles = process.argv.includes("--subscribe");
/** The reader also settles each thread it opened, keeping the Inbox at a person's size. */
const settleCycles = process.argv.includes("--settle");
/** The reader connects again every cycle, as a sleeping laptop or a phone does. */
const reconnectCycles = process.argv.includes("--reconnect");
if (reconnectCycles && !subscribeCycles) throw new Error("--reconnect requires --subscribe");
if (settleCycles && !subscribeCycles) throw new Error("--settle requires --subscribe");
const cpuProfile = argument("cpu-prof", "");
const regions = process.argv.includes("--regions");
const allocationOutput = argument("malloc-stacks", "");
const progress = process.argv.includes("--progress");
let phase = "startup";
function mark(next: string) {
  phase = next;
  if (progress) process.stderr.write(`${phase}\n`);
}
/** The kinds of worker that may stay, one each, once the workload ended (the gate's own). */
const settleKinds = argument("settle-workers", "").split(",").filter(Boolean);
/** Deltas each cycled thread streams before its turn ends. */
const cycleEvents = z.coerce.number().int().min(0).max(10000).parse(argument("cycle-events", "0"));
const warmupCycles = z.coerce.number().int().min(0).max(128).parse(argument("warmup-cycles", "0"));
const home = await mkdtemp(join(tmpdir(), "ace-perf-"));
// Beside the home, not in it: a non-empty unversioned ACE_HOME is backed up to `<home>-v0` at
// startup (ADR 0081), which would move the telemetry directory out from under the daemon.
const telemetry = await mkdtemp(join(tmpdir(), "ace-perf-telemetry-"));
const started = performance.now();
const child = fork(
  resolve(argument("entry", join(import.meta.dirname, "entry.ts"))),
  idleOnly ? ["start"] : [],
  {
    // Bun, the daemon's runtime, unless --node names another (a release's bin/node is Bun too).
    execPath: resolve(argument("node", bunBinary())),
    execArgv: [
      ...(collect ? ["--expose-gc"] : []),
      // --cpu-prof=<dir>: Bun writes the daemon's CPU profile (and a markdown summary) there on
      // exit. The sampler adds CPU of its own, so never combine it with a budget measurement.
      ...(cpuProfile
        ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${resolve(cpuProfile)}`]
        : []),
      "--import",
      join(import.meta.dirname, "telemetry.mjs"),
    ],
    env: {
      ...process.env,
      BUN_OPTIONS: undefined,
      HOME: home,
      USERPROFILE: home,
      PATH: "",
      ACE_HOME: home,
      ACE_HISTORY_INSTANCES: historyInstances,
      ACE_MODEL_INSTANCES: "[]",
      ...(idleOnly ? { ACE_LOG_LEVEL: "silent" } : {}),
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_RELAY_URL: undefined,
      ACE_WORKSPACE_ROOT: home,
      ACE_PERF_TELEMETRY: telemetry,
      // Bun gives a worker no preload of its parent's: ace's workers take this one by name.
      [workerPreloadVariable]: join(import.meta.dirname, "telemetry.mjs"),
      ...(collectWorkers ? { ACE_PERF_COLLECT_WORKERS: "1" } : {}),
      ...(allocationOutput ? { MallocStackLogging: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let stderr = "";
let expectedExit = false;
const aborted = Promise.withResolvers<never>();
child.stderr?.on("data", (chunk: Buffer) => {
  stderr = (stderr + chunk.toString()).slice(-16000);
});
child.stdout?.resume();
let nextId = 0;
const requests = new Map<
  number,
  { resolve(value: z.infer<typeof Response>): void; reject(error: Error): void }
>();
child.on("message", (input: unknown) => {
  const response = Response.safeParse(input);
  if (!response.success) {
    const error = new Error(`Malformed daemon response: ${JSON.stringify(input)}`);
    for (const pending of requests.values()) pending.reject(error);
    aborted.reject(error);
    return;
  }
  requests.get(response.data.id)?.resolve(response.data);
  requests.delete(response.data.id);
});
child.on("exit", () => {
  for (const pending of requests.values()) pending.reject(new Error(`Daemon exited: ${stderr}`));
  requests.clear();
  if (!expectedExit) aborted.reject(new Error(`Daemon exited unexpectedly: ${stderr}`));
});
function request(
  data:
    | { op: "sessions"; count: number }
    | { op: "cycle"; count: number; fresh?: boolean; events?: number }
    | { op: "emit"; thread: string; count: number }
    | { op: "finish"; threads: string[] }
    | { op: "memory" | "plans" },
) {
  const id = ++nextId;
  return new Promise<z.infer<typeof Response>>((fulfill, reject) => {
    requests.set(id, { resolve: fulfill, reject });
    child.send({ id, ...data });
  });
}
async function sample() {
  const { main, workers } = await readWorkerSnapshot({
    read: async (id) =>
      Telemetry.parse(JSON.parse(await readFile(join(telemetry, `${id}.json`), "utf8"))),
    now: () => performance.now(),
    pause: () => delay(10),
    timeoutMs: 4000,
  });
  return {
    runtime: main.runtime,
    memory: main.memory,
    cpu: main.cpu,
    workers: observedWorkers(main, workers).map(({ threadId, kind, memory, collection }) => ({
      threadId,
      kind,
      memory,
      collection,
    })),
  };
}
/**
 * A sample with the process's threads by owner, which take seconds to read. Workers start and
 * retire meanwhile, so it is taken again until the OS counts the same workers before and after
 * the telemetry read; the last try stands either way, and the gate compares the two counts.
 */
async function censusSample() {
  const pid = child.pid;
  if (!pid) throw new Error("Missing child PID");
  let taken;
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await threadCensus(pid);
    const observed = await sample();
    const census = await threadCensus(pid);
    taken = { ...observed, threads: census.total, census };
    if (before.workers === census.workers && census.workers === observed.workers.length) break;
    await delay(500);
  }
  if (!taken) throw new Error("No thread sample");
  return taken;
}
/**
 * The fewest JS workers alive across five seconds of idle. Idle workers retire after five idle
 * seconds and some wake on a timer, so one reading may catch one; a worker that never retires
 * raises the floor.
 */
async function idleWorkerFloor() {
  let floor = Infinity;
  for (let reading = 0; reading < 10; reading++) {
    floor = Math.min(floor, (await sample()).workers.length);
    await delay(500);
  }
  return floor;
}
async function memoryRegions() {
  const pid = child.pid;
  if (!pid) throw new Error("Missing child PID");
  return process.platform === "linux"
    ? readFile(`/proc/${pid}/smaps_rollup`, "utf8")
    : (await run("/usr/bin/vmmap", ["-summary", String(pid)], { maxBuffer: 128 * 1024 })).stdout;
}
let socket: WebSocket | undefined;
let collection = 0;
async function collectMemory() {
  if (collectWorkers) {
    const marker = String(++collection);
    await writeFile(join(telemetry, "collect"), marker);
    const start = performance.now();
    while ((await sample()).workers.some((worker) => worker.collection !== marker)) {
      if (performance.now() - start > 4000) throw new Error("Worker collection timed out");
      await delay(100);
    }
  }
  return request({ op: "memory" });
}
const deadline = setTimeout(
  () =>
    aborted.reject(new TimingFailure(`Daemon measurement timed out during ${phase}: ${stderr}`)),
  // The thread censuses (seconds each on macOS), idle floors and up to 130 s of waiting for the
  // workload's workers to retire.
  idleMs + soakMs + 320000,
);
const interrupt = () => aborted.reject(new TimingFailure("Daemon measurement interrupted"));
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
async function measure() {
  let endpoint = "";
  while (!endpoint) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Startup failed: ${stderr}`);
    if (performance.now() - started > 20000)
      throw new TimingFailure(`Endpoint timed out: ${stderr}`);
    endpoint = await readFile(join(home, "daemon-endpoint"), "utf8").catch(() => "");
    if (!endpoint) await delay(10);
  }
  const startupMs = performance.now() - started;
  mark("idle");
  await delay(Math.min(10000, idleMs));
  const idle10 = await sample();
  await delay(Math.max(0, idleMs - Math.min(10000, idleMs)));
  const idle60 = idleMs >= 60000 ? await sample() : null;
  const idleEnd = idle60 ?? (await sample());
  // After the idle CPU window: reading thread names pauses the process to sample it.
  const idleThreads = { ...(await censusSample()), workerFloor: await idleWorkerFloor() };
  const idleRegions = regions ? await memoryRegions() : undefined;
  const idleCpuPercent =
    (idleEnd.cpu.user + idleEnd.cpu.system - (idle10.cpu.user + idle10.cpu.system)) /
    Math.max(1, idleMs - Math.min(10000, idleMs)) /
    10;
  if (idleOnly) {
    mark("shutdown");
    expectedExit = true;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [exitCode] = await exited;
    if (exitCode !== 0) throw new Error(`Shutdown failed: ${stderr}`);
    const result = {
      runtime: idle10.runtime,
      platform: `${process.platform}-${process.arch}`,
      entry: argument("entry", "source"),
      startupMs,
      idleSampleMs: idleMs,
      idle10,
      idle60,
      idleThreads,
      idleCpuPercent,
      idleRegions,
      stderr,
    };
    const json = JSON.stringify(result, null, 2) + "\n";
    await writeMeasurement(argument("output", ""), json);
    process.stdout.write(json);
    return;
  }
  mark("sessions");
  const active = await request({ op: "sessions", count });
  await delay(1000);
  const activeSample = await censusSample();
  mark("websocket");
  socket = new WebSocket(endpoint.replace("http:", "ws:"));
  await once(socket, "open");
  const received = new Set<number>();
  const latencies: number[] = [];
  const notification = Promise.withResolvers<void>();
  const subscribed = Promise.withResolvers<void>();
  const Delta = z.object({ index: z.number().int(), sentAt: z.number() });
  socket.on("message", (bytes: Buffer) => {
    const message = ServerMessage.parse(JSON.parse(bytes.toString()));
    if (message.type === "welcome")
      socket?.send(
        JSON.stringify({
          type: "subscribe",
          subscriptionId: "perf",
          scope: { kind: "thread", threadId: active.threads[0] },
        }),
      );
    if (message.type === "snapshot") subscribed.resolve();
    if (message.type === "events")
      for (const event of message.events) {
        if (event.payload.type !== "item.delta") continue;
        for (const line of event.payload.append.trim().split("\n")) {
          const data = Delta.parse(JSON.parse(line));
          received.add(data.index);
          latencies.push(performance.timeOrigin + performance.now() - data.sentAt);
        }
        if (received.size === events) notification.resolve();
      }
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: "perf",
      token: await readFile(join(home, "daemon-token"), "utf8"),
    }),
  );
  await subscribed.promise;
  mark("ingest");
  const ingestStarted = performance.now();
  const thread = active.threads[0];
  if (!thread) throw new Error("No active thread");
  await request({ op: "emit", thread, count: events });
  await notification.promise;
  const throughput = events / ((performance.now() - ingestStarted) / 1000);
  latencies.sort((a, b) => a - b);
  socket.close();
  await once(socket, "close");
  socket = undefined;
  const soak: {
    elapsedMs: number;
    rss: number;
    heapUsed: number;
    workers: typeof activeSample.workers;
  }[] = [];
  const token = await readFile(join(home, "daemon-token"), "utf8");
  let reader = subscribeCycles ? await soakReader(endpoint, token, settleCycles) : undefined;
  const cycle = async () => {
    const cycled = await request({
      op: "cycle",
      count: 16,
      fresh: freshCycles,
      events: cycleEvents,
    });
    if (reader && reconnectCycles) {
      await reader.close();
      reader = await soakReader(endpoint, token, settleCycles);
    }
    await reader?.open(cycled.threads);
  };
  mark("warmup");
  for (let i = 0; i < warmupCycles; i++) await cycle();
  mark("collection before soak");
  const collectedStart = collect ? await collectMemory() : null;
  const retainedStart = collectedStart?.memory ?? null;
  const soakStart = performance.now();
  mark("soak");
  while (performance.now() - soakStart < soakMs) {
    await cycle();
    await delay(200);
    const reading = await sample();
    soak.push({
      elapsedMs: performance.now() - soakStart,
      rss: reading.memory.rss,
      heapUsed: reading.memory.heapUsed,
      workers: reading.workers,
    });
  }
  mark("collection after soak");
  const collectedEnd = collect ? await collectMemory() : null;
  const retainedEnd = collectedEnd?.memory ?? null;
  // Open through both collections, so its own connection is in both and only growth differs.
  await reader?.close();
  const endRegions = regions ? await memoryRegions() : undefined;
  if (allocationOutput) {
    if (process.platform !== "darwin" || !child.pid)
      throw new Error("Malloc stack measurements require macOS");
    const allocations = spawn("/usr/bin/malloc_history", [String(child.pid), "-allByCount"]);
    let largest = "";
    let problem = "";
    allocations.stdout.on("data", (data: Buffer) => {
      if (largest.length < 65536) largest += data.toString().slice(0, 65536 - largest.length);
    });
    allocations.stderr.on("data", (data: Buffer) => {
      problem = (problem + data.toString()).slice(-2000);
    });
    const timeout = setTimeout(() => allocations.kill("SIGKILL"), 30000);
    try {
      const [code] = await once(allocations, "exit");
      if (code !== 0) throw new Error(`Allocation profiling failed: ${problem}`);
      await writeFile(resolve(allocationOutput), largest);
    } finally {
      clearTimeout(timeout);
    }
  }
  // The workload's sessions end; the workers it started must retire with them, down to the
  // kinds --settle-workers allows, one each. A busy idle worker stays longer: its idle window
  // doubles while it is reused, up to two minutes. Anything else is waited for that long.
  mark("settle");
  await request({ op: "finish", threads: active.threads });
  const settling = performance.now();
  const unsettled = async () =>
    settledWorkerViolations(
      (await sample()).workers.map((worker) => worker.kind),
      settleKinds,
    ).length > 0;
  while ((await unsettled()) && performance.now() - settling < 130_000) await delay(1000);
  const settledThreads = {
    ...(await censusSample()),
    settleMs: Math.round(performance.now() - settling),
  };
  const queryPlans = (await request({ op: "plans" })).queryPlans;
  mark("shutdown");
  const shuttingDown = performance.now();
  const exited = once(child, "exit");
  expectedExit = true;
  child.send({ id: ++nextId, op: "close" });
  const [exitCode] = await exited;
  if (exitCode !== 0) throw new Error(`Shutdown failed: ${stderr}`);
  const result = {
    runtime: idle10.runtime,
    platform: `${process.platform}-${process.arch}`,
    entry: argument("entry", "source"),
    startupMs,
    idleSampleMs: idleMs,
    idle10,
    idle60,
    idleThreads,
    idleCpuPercent,
    activeSessions: count,
    active: activeSample,
    settledThreads,
    events,
    eventsPerSecond: throughput,
    p99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1],
    soak,
    retainedStart,
    retainedEnd,
    warmupCycles,
    freshCycles,
    collectWorkers,
    queryPlans,
    nativeStart: collectedStart?.native,
    nativeEnd: collectedEnd?.native,
    idleRegions,
    endRegions,
    shutdownMs: performance.now() - shuttingDown,
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  const output = argument("output", "");
  await writeMeasurement(output, json);
  process.stdout.write(json);
}
await measureWithCleanup(
  () => Promise.race([measure(), aborted.promise]),
  async () => {
    clearTimeout(deadline);
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(home, { recursive: true, force: true });
    await rm(telemetry, { recursive: true, force: true });
  },
  (marker) => writeSync(2, `${marker}\n`),
);
