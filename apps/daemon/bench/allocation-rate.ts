/**
 * Bytes the daemon's main isolate allocates, and CPU it spends, per 1,000 streamed deltas.
 * Starts the bench daemon (entry.ts, or a bundle with --entry) with the scripted provider, opens
 * --subscribers WebSocket clients on one active thread, then runs --windows streaming windows of
 * --events deltas each, after one warm-up window. A window ends when every subscriber has
 * received every delta. See allocation-meter.ts for how allocation is estimated.
 */
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";
import { Response } from "./telemetry-schema.ts";
import { writeMeasurement } from "./output.ts";
import { windowAllocation } from "./allocation-meter.ts";
import { bunBinary } from "../../../scripts/runtimes.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const events = z.coerce.number().int().min(100).max(100000).parse(argument("events", "5000"));
const windows = z.coerce.number().int().min(1).max(20).parse(argument("windows", "3"));
const subscribers = z.coerce.number().int().min(0).max(32).parse(argument("subscribers", "1"));
const cpuProfile = argument("cpu-prof", "");
// `--framing=none` subscribes as a client that reads one message per frame.
const framing = z.enum(["lines", "none"]).parse(argument("framing", "lines"));
const home = await mkdtemp(join(tmpdir(), "ace-alloc-"));
const child = fork(resolve(argument("entry", join(import.meta.dirname, "entry.ts"))), [], {
  execPath: resolve(argument("node", bunBinary())),
  execArgv: cpuProfile
    ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${resolve(cpuProfile)}`]
    : [],
  env: {
    ...process.env,
    BUN_OPTIONS: undefined,
    HOME: home,
    USERPROFILE: home,
    PATH: "",
    ACE_HOME: home,
    ACE_HISTORY_INSTANCES: "[]",
    ACE_MODEL_INSTANCES: "[]",
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_RELAY_URL: undefined,
    ACE_WORKSPACE_ROOT: home,
    // JSC logs every collection with the bytes allocated since the last; see allocation-meter.ts.
    BUN_JSC_logGC: "1",
  },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
let stderr = "";
/** The daemon's stderr since the current window was requested. */
let windowLog = "";
child.stderr?.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  stderr = (stderr + text).slice(-16000);
  windowLog += text;
});
const failed = Promise.withResolvers<never>();
let closing = false;
child.on("exit", () => {
  if (!closing) failed.reject(new Error(`Daemon exited: ${stderr}`));
});
let nextId = 0;
const pending = new Map<number, (value: z.infer<typeof Response>) => void>();
child.on("message", (input: unknown) => {
  const response = Response.safeParse(input);
  if (!response.success) return failed.reject(new Error(`Bad response ${JSON.stringify(input)}`));
  pending.get(response.data.id)?.(response.data);
  pending.delete(response.data.id);
});
function request(data: Record<string, unknown>) {
  const id = ++nextId;
  const answer = new Promise<z.infer<typeof Response>>((fulfill) => pending.set(id, fulfill));
  child.send({ id, ...data });
  return Promise.race([answer, failed.promise]);
}

/** A client subscribed to one thread, counting the deltas it receives. */
async function subscriber(endpoint: string, token: string, threadId: string, name: string) {
  const socket = new WebSocket(endpoint.replace("http:", "ws:"));
  await once(socket, "open");
  const subscribed = Promise.withResolvers<void>();
  let received = 0;
  let frames = 0;
  let target = Infinity;
  let reached = Promise.withResolvers<void>();
  socket.on("message", (bytes: Buffer) => {
    frames++;
    for (const line of bytes.toString().split("\n")) receive(line);
  });
  const receive = (text: string) => {
    const message = ServerMessage.parse(JSON.parse(text));
    if (message.type === "welcome")
      socket.send(
        JSON.stringify({
          type: "subscribe",
          subscriptionId: name,
          scope: { kind: "thread", threadId },
        }),
      );
    if (message.type === "snapshot") subscribed.resolve();
    if (message.type !== "events") return;
    for (const event of message.events)
      if (event.payload.type === "item.delta")
        received += event.payload.append.trim().split("\n").length;
    if (received >= target) reached.resolve();
  };
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: name,
      token,
      ...(framing === "lines" ? { framing: ["lines"] } : {}),
    }),
  );
  await subscribed.promise;
  return {
    get frames() {
      return frames;
    },
    expect(count: number) {
      target = received + count;
      reached = Promise.withResolvers<void>();
      if (received >= target) reached.resolve();
      return reached.promise;
    },
    async close() {
      socket.close();
      await once(socket, "close");
    },
  };
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

async function main() {
  let endpoint = "";
  while (!endpoint) {
    endpoint = await readFile(join(home, "daemon-endpoint"), "utf8").catch(() => "");
    if (!endpoint) await Promise.race([delay(10), failed.promise]);
  }
  const token = await readFile(join(home, "daemon-token"), "utf8");
  const thread = (await request({ op: "sessions", count: 1 })).threads[0];
  if (!thread) throw new Error("No active thread");
  const clients = [];
  for (let index = 0; index < subscribers; index++)
    clients.push(await subscriber(endpoint, token, thread, `alloc-${index}`));
  const results = [];
  for (let window = 0; window <= windows; window++) {
    const received = Promise.all(clients.map((client) => client.expect(events)));
    const framesBefore = clients.reduce((sum, client) => sum + client.frames, 0);
    windowLog = "";
    await request({ op: "meter-start" });
    const started = performance.now();
    await request({ op: "emit", thread, count: events });
    await Promise.race([received, failed.promise]);
    const wallMs = performance.now() - started;
    const frames = clients.reduce((sum, client) => sum + client.frames, 0) - framesBefore;
    const meter = (await request({ op: "meter-stop" })).meter;
    if (!meter) throw new Error("No meter reading");
    let allocation = windowAllocation(windowLog);
    for (let tries = 0; !allocation && tries < 500; tries++) {
      await delay(10);
      allocation = windowAllocation(windowLog);
    }
    if (!allocation) throw new Error("The window's GC log never completed");
    // Window 0 warms the JIT, caches and statements; it is not reported.
    if (window === 0) continue;
    const cpuMs = (meter.cpuUserUs + meter.cpuSystemUs) / 1000;
    results.push({
      ...meter,
      ...allocation,
      wallMs,
      allocatedPer1000: (allocation.mainBytes / events) * 1000,
      workerAllocatedPer1000: (allocation.workerBytes / events) * 1000,
      cpuMsPer1000: (cpuMs / events) * 1000,
      // WebSocket frames each subscriber received.
      framesPer1000: clients.length ? (frames / clients.length / events) * 1000 : 0,
    });
  }
  for (const client of clients) await client.close();
  const summary = {
    entry: argument("entry", "source"),
    events,
    subscribers,
    framing,
    windows: results,
    allocatedPer1000: median(results.map((r) => r.allocatedPer1000)),
    workerAllocatedPer1000: median(results.map((r) => r.workerAllocatedPer1000)),
    collectionsPer1000: median(results.map((r) => (r.mainCollections / events) * 1000)),
    transactionsPer1000: median(results.map((r) => (r.transactions / events) * 1000)),
    cpuMsPer1000: median(results.map((r) => r.cpuMsPer1000)),
    framesPer1000: median(results.map((r) => r.framesPer1000)),
    peakHeapUsed: median(results.map((r) => r.peakHeapUsed)),
    eventsPerSecond: median(results.map((r) => (events / r.wallMs) * 1000)),
  };
  const json = JSON.stringify(summary, null, 2) + "\n";
  await writeMeasurement(argument("output", ""), json);
  process.stdout.write(json);
}
try {
  await main();
} finally {
  closing = true;
  if (child.connected) {
    const exited = once(child, "exit");
    child.send({ id: ++nextId, op: "close" });
    await Promise.race([exited, delay(10000)]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(home, { recursive: true, force: true });
}
