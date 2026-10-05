import { z } from "zod";
import type { Fact, Key } from "@ace/core";
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Usage = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  reasoningTokens: tokens.optional(),
});
/** onDelta is authoritative per-turn. Run.wait usage is cumulative and never added again. */
export function turnUsage(value: unknown, agent: Key, counterKey: string): Fact[] {
  const parsed = Usage.safeParse(value);
  if (!parsed.success) return [];
  const usage = parsed.data;
  const occupied =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return [
    ...(Number.isSafeInteger(occupied)
      ? [{ type: "context.sample" as const, agent, usedTokens: occupied }]
      : []),
    {
      type: "usage",
      agent,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cachedInputTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      counterMode: "cumulative",
      counterKey,
      billingMode: "unknown",
    },
  ];
}
