import { z } from "zod";
import { AgentId } from "./ids.ts";

/** Occupancy is a replaceable sample, separate from billing counters. */
export const ContextMeter = z.object({
  agentId: AgentId,
  epoch: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative().nullable(),
  windowTokens: z.number().int().positive().nullable(),
  model: z.string().optional(),
  source: z.enum(["provider", "catalog", "unknown"]),
});
export type ContextMeter = z.infer<typeof ContextMeter>;
export const ContextMeterUpdated = z.object({
  type: z.literal("context_meter.updated"),
  meter: ContextMeter,
});

export const ContextSampled = z.object({
  type: z.literal("context.sampled"),
  agentId: AgentId,
  usedTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  model: z.string().optional(),
});
