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
  logs: z.object({
    dropped: count,
    failed: count,
    queued: count,
    /** Where the daemon writes its log files (absolute, on the daemon's machine). */
    directory: z.string().min(1).max(4096).optional(),
  }),
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

export const DiagnosticCheck = z.object({
  id: z.string().max(128),
  status: z.enum(["ok", "warn", "fail"]),
  message: z.string().max(2048),
  fix: z.string().max(2048),
});
export const DiagnosticReport = z.object({
  at: z.number(),
  checks: z.array(DiagnosticCheck).max(64),
});
export type DiagnosticReport = z.infer<typeof DiagnosticReport>;
export const Toolchain = z.object({
  id: z.enum(["git", "xcode", "android"]),
  available: z.boolean(),
  detail: z.string().max(2048),
  hint: z.string().max(2048),
});
export type Toolchain = z.infer<typeof Toolchain>;
export const DiagnosticsRequest = z.object({
  type: z.literal("diagnostics.request"),
  requestId: z.string().min(1).max(128),
  operation: z.enum(["doctor", "toolchains"]),
});
export const DiagnosticsResult = z.object({
  type: z.literal("diagnostics.result"),
  requestId: z.string().min(1).max(128),
  report: DiagnosticReport.optional(),
  toolchains: z.array(Toolchain).max(3).optional(),
  error: z.string().max(256).optional(),
});
