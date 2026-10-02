import { z } from "zod";
import type { UsageUpdated } from "@ace/protocol";
export const Counts = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cached: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
  write: z.number().nonnegative(),
  write1h: z.number().nonnegative(),
  cost: z.number().nonnegative(),
});
export type Counts = z.infer<typeof Counts>;
export const zeroCounts: Counts = {
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  write: 0,
  write1h: 0,
  cost: 0,
};
export function normalizeUsage(
  usage: Omit<UsageUpdated, "agentId">,
  previous: Counts,
): { delta: Counts; next: Counts } {
  const values = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cached: usage.cachedInputTokens,
    reasoning: usage.reasoningTokens,
    write: usage.cacheWriteTokens,
    write1h: usage.cacheWrite1hTokens,
    cost: usage.costUsd,
  };
  const next = { ...previous };
  const delta = { ...zeroCounts };
  for (const parsedKey of [
    "input",
    "output",
    "cached",
    "reasoning",
    "write",
    "write1h",
    "cost",
  ] as const) {
    const value = values[parsedKey];
    if (value !== undefined) {
      next[parsedKey] = Math.max(previous[parsedKey], value);
      delta[parsedKey] = next[parsedKey] - previous[parsedKey];
    }
  }
  return { delta, next };
}
