import { z } from "zod";

const bytes = z.number().nonnegative();
/** Memory after a forced full GC. Footprint is macOS only. */
export const Memory = z.object({
  heapUsed: bytes,
  rss: bytes,
  footprint: bytes.optional(),
});
export const Phase = z.object({
  turns: z.number().int().positive(),
  wallMs: z.number().nonnegative(),
  /** Daemon CPU (every thread) per turn, in milliseconds. */
  cpuMsPerTurn: z.number().nonnegative(),
  /** cpuMsPerTurn divided by the calibration time: comparable across machines. */
  cpuPerTurn: z.number().nonnegative(),
  /** SQLite write transactions the daemon committed per turn. */
  transactionsPerTurn: z.number().nonnegative(),
  memory: Memory,
});
export type Phase = z.infer<typeof Phase>;
export const BenchResult = z.object({
  version: z.literal(1),
  platform: z.string(),
  node: z.string(),
  options: z.record(z.string(), z.number()),
  /** On-thread CPU for a fixed workload in the daemon process, fastest of several runs. */
  calibrationMs: z.number().positive(),
  startup: Memory,
  idle: z.object({
    seconds: z.number().positive(),
    /** Percent of one core. */
    cpuPercent: z.number().nonnegative(),
    /** Idle CPU per minute divided by the calibration time. */
    cpuPerMinute: z.number().nonnegative(),
    memory: Memory,
  }),
  phases: z.object({ newThreads: Phase, sameThread: Phase, longText: Phase }),
});
export type BenchResult = z.infer<typeof BenchResult>;
