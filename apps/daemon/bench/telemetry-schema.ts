import { z } from "zod";

export const Memory = z.object({
  rss: z.number(),
  heapUsed: z.number(),
  heapTotal: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});
export const Telemetry = z.object({
  threadId: z.number().int().nonnegative(),
  runtime: z.string(),
  entry: z.string().default("unknown"),
  collection: z.string().default(""),
  at: z.number(),
  isMainThread: z.boolean(),
  workerIds: z.array(z.number().int().positive()),
  pendingWorkerIds: z.array(z.number().int().positive()),
  /** The module each worker this isolate started runs, by worker id. */
  workerEntries: z.record(z.string(), z.string()).default({}),
  generation: z.number().int().nonnegative(),
  memory: Memory,
  cpu: z.object({ user: z.number(), system: z.number() }),
});
export const Response = z.object({
  id: z.number(),
  threads: z.array(z.string()),
  memory: Memory,
  meter: z
    .object({
      peakHeapUsed: z.number(),
      transactions: z.number(),
      cpuUserUs: z.number(),
      cpuSystemUs: z.number(),
    })
    .optional(),
  queryPlans: z.record(z.string(), z.array(z.object({ detail: z.string() }))).optional(),
  native: z
    .object({
      statements: z.number(),
      databases: z.number(),
      code: z.record(z.string(), z.number()),
    })
    .optional(),
});
