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
  queues: z
    .record(z.string().max(128), count)
    .refine((value) => Object.keys(value).length <= 64)
    .meta({ maxProperties: 64, "x-ace-constraint": "At most 64 queue entries." }),
  logs: z.object({ dropped: count, failed: count, queued: count }),
});
export type DiagnosticsHealth = z.infer<typeof DiagnosticsHealth>;

export const DiagnosticsHealthRequest = z.object({
  type: z.literal("diagnostics.health"),
  requestId: z.string().min(1).max(128),
});
export const DiagnosticsHealthResult = z.object({
  type: z.literal("diagnostics.health.result"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  health: DiagnosticsHealth.optional(),
  error: z.string().max(256).optional(),
});
