/**
 * Allocation and CPU per 1,000 provider frames through the real adapters' translators.
 * Replays the recorded sessions under fixtures/ (no provider CLI, no quota) through each
 * provider's translator, the engine, SQLite and a real WebSocket subscriber in this process
 * (adapter-replay-child.ts is the measured side). Allocation is read from JSC's GC log as in
 * allocation-rate.ts; see allocation-meter.ts.
 *
 *   bun apps/daemon/bench/adapter-replay.ts --runs=3 --frames=5000 [--providers=claude,codex]
 *     [--cpu-prof=<dir>] [checkout …]
 *
 * With several checkouts (each holding these bench files), runs interleave A B A B per provider
 * so host load lands on each alike; each row is the median of the per-run window medians.
 */
import { fork } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { z } from "zod";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { windowAllocation } from "./allocation-meter.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = z.coerce.number().int().min(1).parse(argument("runs", "3"));
const frames = z.coerce.number().int().min(100).parse(argument("frames", "5000"));
const windows = z.coerce.number().int().min(1).max(20).parse(argument("windows", "3"));
const providers = argument("providers", "claude,codex,cursor,opencode").split(",");
const cpuProfile = argument("cpu-prof", "");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const checkouts = positional.length
  ? positional.map((path) => resolve(path))
  : [resolve(import.meta.dirname, "../../..")];

const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    url: z.string(),
    token: z.string(),
    threads: z.array(z.array(z.string())),
  }),
  z.object({ type: z.literal("replayed"), frames: z.number(), head: z.number() }),
  z.object({
    type: z.literal("stopped"),
    peakHeapUsed: z.number(),
    cpuUserUs: z.number(),
    cpuSystemUs: z.number(),
    transactions: z.number(),
  }),
]);
type Message = z.infer<typeof Message>;

/** One socket subscribed to every replay thread, tracking the newest event seq delivered. */
async function subscribe(url: string, token: string, threads: string[]) {
  const socket = new WebSocket(url.replace("http:", "ws:"));
  await once(socket, "open");
  let delivered = 0;
  let snapshots = 0;
  const ready = Promise.withResolvers<void>();
  socket.on("message", (bytes: Buffer) => {
    const message: unknown = JSON.parse(bytes.toString());
    const parsed = z
      .looseObject({ type: z.string(), throughSeq: z.number().optional() })
      .safeParse(message);
    if (!parsed.success) return;
    if (parsed.data.type === "welcome")
      for (const threadId of threads)
        socket.send(
          JSON.stringify({
            type: "subscribe",
            subscriptionId: threadId,
            scope: { kind: "thread", threadId },
          }),
        );
    if (parsed.data.type === "snapshot" && ++snapshots === threads.length) ready.resolve();
    if (parsed.data.type === "events") delivered = Math.max(delivered, parsed.data.throughSeq ?? 0);
  });
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "replay", token }));
  await ready.promise;
  return {
    async reach(head: number) {
      const deadline = performance.now() + 5_000;
      for (;;) {
        if (delivered >= head) return;
        if (performance.now() > deadline)
          throw new Error(`Subscriber stopped at ${delivered} of ${head}`);
        await delay(5);
      }
    },
    async close() {
      socket.close();
      await once(socket, "close");
    },
  };
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

async function measure(checkout: string, provider: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-adapter-replay-"));
  const child = fork(
    join(checkout, "apps/daemon/bench/adapter-replay-child.ts"),
    [`--provider=${provider}`, `--frames=${frames}`, `--windows=${windows}`],
    {
      cwd: checkout,
      execPath: bunBinary(),
      execArgv: cpuProfile
        ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${resolve(cpuProfile)}`]
        : [],
      env: {
        ...process.env,
        BUN_OPTIONS: undefined,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        ACE_HOME: home,
        PATH: "",
        BUN_JSC_logGC: "1",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let log = "";
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    log += text;
    tail = (tail + text).slice(-8000);
  });
  const failed = Promise.withResolvers<never>();
  let closing = false;
  child.on("exit", () => {
    if (!closing) failed.reject(new Error(`Replay child exited: ${tail}`));
  });
  const inbox: Message[] = [];
  let waiter: (() => void) | undefined;
  child.on("message", (input: unknown) => {
    inbox.push(Message.parse(input));
    waiter?.();
  });
  async function next<T extends Message["type"]>(type: T): Promise<Extract<Message, { type: T }>> {
    for (;;) {
      const message = inbox.shift();
      if (message) {
        if (message.type !== type) throw new Error(`Expected ${type}, got ${message.type}`);
        return message as Extract<Message, { type: T }>;
      }
      await Promise.race([new Promise<void>((wake) => (waiter = wake)), failed.promise]);
    }
  }
  try {
    const ready = await next("ready");
    const subscriber = await subscribe(ready.url, ready.token, ready.threads.flat());
    const results = [];
    for (let window = 0; window <= windows; window++) {
      log = "";
      child.send({ op: "window", window });
      const replayed = await next("replayed");
      await Promise.race([subscriber.reach(replayed.head), failed.promise]);
      child.send({ op: "stop" });
      const reading = await next("stopped");
      let allocation = windowAllocation(log);
      for (let tries = 0; !allocation && tries < 500; tries++) {
        await delay(10);
        allocation = windowAllocation(log);
      }
      if (!allocation) throw new Error("The window's GC log never completed");
      // Window 0 warms the JIT, caches and statements; it is not reported.
      if (window === 0) continue;
      const per1000 = 1000 / replayed.frames;
      results.push({
        allocatedPer1000: allocation.mainBytes * per1000,
        cpuMsPer1000: ((reading.cpuUserUs + reading.cpuSystemUs) / 1000) * per1000,
        transactionsPer1000: reading.transactions * per1000,
        peakHeapUsed: reading.peakHeapUsed,
      });
    }
    await subscriber.close();
    return {
      allocatedPer1000: median(results.map((r) => r.allocatedPer1000)),
      cpuMsPer1000: median(results.map((r) => r.cpuMsPer1000)),
      transactionsPer1000: median(results.map((r) => r.transactionsPer1000)),
      peakHeapUsed: median(results.map((r) => r.peakHeapUsed)),
    };
  } finally {
    closing = true;
    if (child.connected) {
      const exited = once(child, "exit");
      child.send({ op: "close" });
      await Promise.race([exited, delay(10000)]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}

const results = new Map<string, Awaited<ReturnType<typeof measure>>[]>();
for (let run = 0; run < runs; run++)
  for (const provider of providers)
    for (const checkout of checkouts) {
      const result = await measure(checkout, provider);
      const key = `${checkout}\0${provider}`;
      results.set(key, [...(results.get(key) ?? []), result]);
      process.stderr.write(`${checkout} ${provider} run ${run + 1}: ${JSON.stringify(result)}\n`);
    }
const rows = [...results].map(([key, list]) => {
  const [checkout, provider] = key.split("\0");
  return {
    checkout,
    provider,
    runs: list.length,
    allocatedKBPer1000: Math.round(median(list.map((r) => r.allocatedPer1000)) / 1024),
    cpuMsPer1000: Math.round(median(list.map((r) => r.cpuMsPer1000))),
    transactionsPer1000: Math.round(median(list.map((r) => r.transactionsPer1000))),
    peakHeapUsedMB: Math.round(median(list.map((r) => r.peakHeapUsed)) / 1e5) / 10,
  };
});
process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
