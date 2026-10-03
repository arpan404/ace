import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";

const Memory = z.object({
  rss: z.number(),
  heapUsed: z.number(),
  heapTotal: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});
const Telemetry = z.object({
  threadId: z.number(),
  runtime: z.string(),
  at: z.number(),
  isMainThread: z.boolean(),
  memory: Memory,
  cpu: z.object({ user: z.number(), system: z.number() }),
});
const Response = z.object({ id: z.number(), threads: z.array(z.string()), memory: Memory });
const run = promisify(execFile);
const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const idleMs = z.coerce.number().int().min(3000).parse(argument("idle-ms", "60000"));
const count = z.coerce.number().int().min(1).max(64).parse(argument("sessions", "16"));
const events = z.coerce.number().int().min(100).max(100000).parse(argument("events", "1000"));
const soakMs = z.coerce.number().int().min(0).parse(argument("soak-ms", "10000"));
const collect = process.argv.includes("--collect");
const warmupCycles = z.coerce.number().int().min(0).max(128).parse(argument("warmup-cycles", "0"));
const home = await mkdtemp(join(tmpdir(), "ace-perf-"));
const telemetry = join(home, "telemetry");
await mkdir(telemetry);
const started = performance.now();
const child = fork(resolve(argument("entry", join(import.meta.dirname, "entry.ts"))), [], {
  execPath: resolve(argument("node", process.execPath)),
  execArgv: [
    ...(collect ? ["--expose-gc"] : []),
    "--import",
    join(import.meta.dirname, "telemetry.mjs"),
  ],
  env: {
    ...process.env,
    ACE_HOME: home,
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_RELAY_URL: undefined,
    ACE_WORKSPACE_ROOT: home,
    ACE_PERF_TELEMETRY: telemetry,
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let stderr = "";
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
    for (const pending of requests.values()) pending.reject(new Error(JSON.stringify(input)));
    return;
  }
  requests.get(response.data.id)?.resolve(response.data);
  requests.delete(response.data.id);
});
child.on("exit", () => {
  for (const pending of requests.values()) pending.reject(new Error(`Daemon exited: ${stderr}`));
  requests.clear();
});
function request(
  data:
    | { op: "sessions" | "cycle"; count: number }
    | { op: "emit"; thread: string; count: number }
    | { op: "memory" },
) {
  const id = ++nextId;
  return new Promise<z.infer<typeof Response>>((fulfill, reject) => {
    requests.set(id, { resolve: fulfill, reject });
    child.send({ id, ...data });
  });
}
async function sample() {
  const samples = await Promise.all(
    (await readdir(telemetry)).map(async (file) =>
      Telemetry.parse(JSON.parse(await readFile(join(telemetry, file), "utf8"))),
    ),
  );
  const main = samples.find((entry) => entry.threadId === 0);
  if (!main) throw new Error("Missing main telemetry");
  const live = samples.filter((entry) => main.at - entry.at < 1500);
  const pid = child.pid;
  if (!pid) throw new Error("Missing child PID");
  const threads =
    process.platform === "linux"
      ? (await readdir(`/proc/${pid}/task`)).length
      : (await run("ps", ["-M", "-p", String(pid)])).stdout.trim().split("\n").length - 1;
  return {
    runtime: main.runtime,
    memory: main.memory,
    cpu: main.cpu,
    threads,
    workers: live
      .filter((entry) => !entry.isMainThread)
      .map(({ threadId, memory }) => ({ threadId, memory })),
  };
}
let socket: WebSocket | undefined;
const deadline = setTimeout(
  () => {
    child.kill("SIGKILL");
  },
  idleMs + soakMs + 55000,
);
try {
  let endpoint = "";
  while (!endpoint) {
    if (child.exitCode !== null) throw new Error(`Startup failed: ${stderr}`);
    if (performance.now() - started > 20000) throw new Error(`Endpoint timed out: ${stderr}`);
    endpoint = await readFile(join(home, "daemon-endpoint"), "utf8").catch(() => "");
    if (!endpoint) await delay(10);
  }
  const startupMs = performance.now() - started;
  await delay(Math.min(10000, idleMs));
  const idle10 = await sample();
  await delay(Math.max(0, idleMs - Math.min(10000, idleMs)));
  const idle60 = idleMs >= 60000 ? await sample() : null;
  const idleEnd = idle60 ?? (await sample());
  const idleCpuPercent =
    (idleEnd.cpu.user + idleEnd.cpu.system - (idle10.cpu.user + idle10.cpu.system)) /
    Math.max(1, idleMs - Math.min(10000, idleMs)) /
    10;
  const active = await request({ op: "sessions", count });
  await delay(1000);
  const activeSample = await sample();
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
  const soak: { elapsedMs: number; rss: number; heapUsed: number }[] = [];
  for (let i = 0; i < warmupCycles; i++) await request({ op: "cycle", count: 16 });
  const retainedStart = collect ? (await request({ op: "memory" })).memory : null;
  const soakStart = performance.now();
  while (performance.now() - soakStart < soakMs) {
    await request({ op: "cycle", count: 16 });
    await delay(200);
    const reading = await sample();
    soak.push({
      elapsedMs: performance.now() - soakStart,
      rss: reading.memory.rss,
      heapUsed: reading.memory.heapUsed,
    });
  }
  const retainedEnd = collect ? (await request({ op: "memory" })).memory : null;
  const shuttingDown = performance.now();
  const exited = once(child, "exit");
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
    idleCpuPercent,
    activeSessions: count,
    active: activeSample,
    events,
    eventsPerSecond: throughput,
    p99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1],
    soak,
    retainedStart,
    retainedEnd,
    warmupCycles,
    shutdownMs: performance.now() - shuttingDown,
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  const output = argument("output", "");
  if (output) await writeFile(resolve(output), json);
  process.stdout.write(json);
} finally {
  clearTimeout(deadline);
  socket?.terminate();
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  await rm(home, { recursive: true, force: true });
}
