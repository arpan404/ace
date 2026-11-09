import { z } from "zod";
const count = z.number().int().nonnegative();
/** Cumulative counters; compare samples to derive transaction rate and rows per batch. */
export const StreamingStorageMetrics = z.object({
  transactions: count,
  eventRows: count,
  flushes: count,
  rows: count,
  failures: count,
  liveBytes: count,
  peakBytes: count,
  bufferedBytes: count,
  walBytes: count,
  replayResyncs: count,
  reads: z.object({
    hits: count,
    misses: count,
    hitBytes: count,
    invalidations: count,
    evictions: count,
    bytes: count,
    staleServes: count,
  }),
});
export type StreamingStorageMetrics = z.infer<typeof StreamingStorageMetrics>;
export const DiagnosticsHealthCommand = z.object({ type: z.literal("diagnostics.health") });
export const DiagnosticsHealth = z.object({
  at: z.number().nonnegative(),
  eventLoop: z.object({
    meanMs: z.number().nonnegative().nullable(),
    p99Ms: z.number().nonnegative().nullable(),
    maxMs: z.number().nonnegative().nullable(),
  }),
  memory: z.object({ rssBytes: count, heapUsedBytes: count, heapTotalBytes: count }),
  /** Node: active handles and requests. Bun: open file descriptors (0 on Windows, unmeasured). */
  openHandles: count,
  sqlite: z.object({ pageBytes: count.nullable(), walBytes: count.nullable() }),
  activeSessions: count.nullable(),
  streaming: StreamingStorageMetrics.optional(),
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
export const DiagnosticRepair = z.object({
  id: z.string().max(128),
  status: z.enum(["fixed", "failed", "skipped"]),
  message: z.string().max(2048),
});
export type DiagnosticRepair = z.infer<typeof DiagnosticRepair>;
export const Toolchain = z.object({
  id: z.enum(["git", "xcode", "android", "serve-sim"]),
  available: z.boolean(),
  detail: z.string().max(2048),
  hint: z.string().max(2048),
  /** The tool's version, when it could be read ("26.0"). */
  version: z.string().max(64).optional(),
});
export type Toolchain = z.infer<typeof Toolchain>;
/**
 * The daemon's checks run (Run checks or Run safe repairs), shared by every app: one runs at a
 * time, and the last one's outcome stays readable until the next starts.
 */
const checksOperation = z.enum(["doctor", "fix"]);
/** One checks run, for joining exactly that run (`join`) and never starting another. */
const runId = z.string().min(1).max(128);
export const DiagnosticsRun = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({
    state: z.literal("running"),
    id: runId,
    operation: checksOperation,
    startedAt: z.number(),
    /** How long it had run when this was read: clocks on two machines may disagree. */
    elapsedMs: z.number().nonnegative(),
  }),
  z.object({
    state: z.literal("done"),
    id: runId,
    operation: checksOperation,
    startedAt: z.number(),
    finishedAt: z.number(),
    report: DiagnosticReport,
    repairs: z.array(DiagnosticRepair).max(8).optional(),
  }),
  z.object({
    state: z.literal("failed"),
    id: runId,
    operation: checksOperation,
    startedAt: z.number(),
    finishedAt: z.number(),
  }),
]);
export type DiagnosticsRun = z.infer<typeof DiagnosticsRun>;
export const DiagnosticsRequest = z.object({
  type: z.literal("diagnostics.request"),
  requestId: z.string().min(1).max(128),
  /**
   * `doctor` and `fix` start the checks run, or join it when the same one is already running;
   * `status` reads the run without starting one; `join` waits for the run `runId` names and
   * answers its outcome, or `diagnostics_run_gone` when that run is no longer the current or
   * last one. `join` never starts work and needs only read access, even for repairs.
   */
  operation: z.enum(["doctor", "toolchains", "fix", "status", "join"]),
  runId: runId.optional(),
});
export const DiagnosticsResult = z.object({
  type: z.literal("diagnostics.result"),
  requestId: z.string().min(1).max(128),
  report: DiagnosticReport.optional(),
  repairs: z.array(DiagnosticRepair).max(8).optional(),
  toolchains: z.array(Toolchain).max(4).optional(),
  /** The checks run, answering `status`. */
  run: DiagnosticsRun.optional(),
  error: z.string().max(256).optional(),
});
