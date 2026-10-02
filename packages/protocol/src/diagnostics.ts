import { z } from "zod";
const count = z.number().int().nonnegative();
export const DiagnosticsHealthCommand = z.object({ type: z.literal("diagnostics.health") });
export const DiagnosticsHealth = z.object({
  at: z.number().nonnegative(),
  eventLoop: z.object({
    meanMs: z.number().nonnegative().nullable(),
    p99Ms: z.number().nonnegative().nullable(),
    maxMs: z.number().nonnegative().nullable(),
  }),
  memory: z.object({ rssBytes: count, heapUsedBytes: count, heapTotalBytes: count }),
  openHandles: count,
  sqlite: z.object({ pageBytes: count.nullable(), walBytes: count.nullable() }),
  activeSessions: count.nullable(),
  queues: z.record(z.string().max(128), count).refine((value) => Object.keys(value).length <= 64),
  logs: z.object({ dropped: count, failed: count, queued: count }),
});
export type DiagnosticsHealth = z.infer<typeof DiagnosticsHealth>;
