import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nativeCounts = z
  .object({
    input_tokens: count.optional(),
    output_tokens: count.optional(),
    output_tokens_details: z.object({ thinking_tokens: count.optional() }).passthrough().optional(),
    cache_read_input_tokens: count.nullish(),
    cache_creation_input_tokens: count.nullish(),
    cache_creation: z
      .object({
        ephemeral_1h_input_tokens: count.optional(),
        ephemeral_5m_input_tokens: count.optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens?: number;
}
export const zeroCounts = (): TokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
});
export function tokenCounts(data: unknown): TokenCounts | undefined {
  const parsed = nativeCounts.safeParse(data);
  if (!parsed.success) return undefined;
  const usage = parsed.data;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: Math.min(
      Number.MAX_SAFE_INTEGER,
      (usage.input_tokens ?? 0) + cachedInputTokens + cacheWriteTokens,
    ),
    outputTokens: usage.output_tokens ?? 0,
    ...(usage.output_tokens_details?.thinking_tokens === undefined
      ? {}
      : {
          reasoningTokens: Math.min(
            usage.output_tokens ?? 0,
            usage.output_tokens_details.thinking_tokens,
          ),
        }),
    cachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: Math.min(
      cacheWriteTokens,
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    ),
  };
}
