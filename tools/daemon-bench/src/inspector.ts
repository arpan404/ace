import { createWriteStream } from "node:fs";
import { z } from "zod";
import { WebSocket } from "ws";

const Reply = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const Chunk = z.object({
  method: z.literal("HeapProfiler.addHeapSnapshotChunk"),
  params: z.object({ chunk: z.string() }),
});
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.object({ text: z.string() }).optional(),
});
/** Process-wide counters read inside the daemon; CPU includes every worker thread. */
const Counters = z.object({
  cpuMicros: z.number().nonnegative(),
  heapUsed: z.number().nonnegative(),
  rss: z.number().nonnegative(),
});
export type Counters = z.infer<typeof Counters>;

const countersExpression = `(() => {
  const cpu = process.cpuUsage(); const memory = process.memoryUsage();
  return { cpuMicros: cpu.user + cpu.system, heapUsed: memory.heapUsed, rss: memory.rss };
})()`;
/**
 * A fixed allocation, JSON and Map workload, the kinds of work a turn spends CPU on. Its
 * on-thread CPU time measures this machine and runtime, so CPU per turn can be normalized.
 */
const calibrationExpression = `(() => {
  const clock = () => { const t = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return t.user + t.system; };
  const start = clock();
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push({ id: "item-" + i, text: "x".repeat(i % 64), n: i, done: i % 3 === 0 });
  let total = 0;
  for (let round = 0; round < 8; round++) {
    const copy = JSON.parse(JSON.stringify(rows));
    const index = new Map();
    for (const row of copy) index.set(row.id, row);
    total += index.size + copy.length;
  }
  return { ms: (clock() - start) / 1000, total };
})()`;

/** The daemon's V8 inspector: forced GC, in-process counters and calibration. */
export class Inspector {
  private next = 0;
  private readonly pending = new Map<number, (reply: z.infer<typeof Reply>) => void>();
  private readonly socket: WebSocket;
  private onChunk: ((chunk: string) => void) | undefined;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      const chunk = Chunk.safeParse(message);
      if (chunk.success) return this.onChunk?.(chunk.data.params.chunk);
      const reply = Reply.safeParse(message);
      if (!reply.success) return; // Other notifications carry no id.
      this.pending.get(reply.data.id)?.(reply.data);
      this.pending.delete(reply.data.id);
    });
  }
  static async connect(url: string): Promise<Inspector> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new Inspector(socket);
  }
  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.error
          ? reject(new Error(`${method}: ${reply.error.message}`))
          : resolve(reply.result),
      );
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  private async evaluate(expression: string): Promise<unknown> {
    const evaluated = Evaluated.parse(
      await this.send("Runtime.evaluate", { expression, returnByValue: true }),
    );
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
    return evaluated.result.value;
  }
  counters(): Promise<Counters> {
    return this.evaluate(countersExpression).then((value) => Counters.parse(value));
  }
  /** Main-isolate heap after a full collection, plus process RSS at that moment. */
  async collected(): Promise<Counters> {
    await this.send("HeapProfiler.collectGarbage");
    // A second pass frees what the first one's finalizers released.
    await this.send("HeapProfiler.collectGarbage");
    return this.counters();
  }
  /** Fastest of several runs: interference from a loaded machine only ever adds time. */
  async calibrate(runs = 7): Promise<number> {
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const { ms } = z
        .object({ ms: z.number().positive() })
        .parse(await this.evaluate(calibrationExpression));
      times.push(ms);
    }
    return Math.min(...times);
  }
  /** Writes a main-isolate heap snapshot (after the forced GC V8 does first) to `path`. */
  async snapshot(path: string): Promise<void> {
    const file = createWriteStream(path);
    this.onChunk = (chunk) => file.write(chunk);
    try {
      await this.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    } finally {
      this.onChunk = undefined;
      await new Promise<void>((resolve, reject) =>
        file.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
    }
  }
  /** Starts the main-isolate CPU sampler. */
  async profileStart(intervalUs: number): Promise<void> {
    await this.send("Profiler.enable");
    await this.send("Profiler.setSamplingInterval", { interval: intervalUs });
    await this.send("Profiler.start");
  }
  /** Stops the sampler and returns the `.cpuprofile` JSON. */
  async profileStop(): Promise<unknown> {
    const result = z.object({ profile: z.unknown() }).parse(await this.send("Profiler.stop"));
    await this.send("Profiler.disable");
    return result.profile;
  }
  /** Evaluates an expression in the daemon's main isolate and returns its JSON value. */
  value(expression: string): Promise<unknown> {
    return this.evaluate(expression);
  }
  close() {
    this.socket.close();
  }
}
