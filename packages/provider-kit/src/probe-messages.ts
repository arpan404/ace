import { z } from "zod";

/** Messages between the main thread and the probe worker (probe-worker.ts). */
export const ProbeRequest = z.object({
  type: z.literal("run"),
  id: z.number().int().nonnegative(),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  maxBytes: z.number().int().positive(),
});
export type ProbeRequest = z.infer<typeof ProbeRequest>;
export const ProbeStop = z.object({ type: z.literal("stop"), id: z.number().int().nonnegative() });

export const ProbeReply = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spawned"),
    id: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("exit"),
    id: z.number().int().nonnegative(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    reason: z.enum(["exit", "signal", "stopped", "spawn-error", "output-limit"]),
    stdout: z.string(),
    stderr: z.string(),
  }),
]);
export type ProbeReply = z.infer<typeof ProbeReply>;
