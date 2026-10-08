import { z } from "zod";

const id = z.string().min(1).max(512);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Scope/key validity survives schema extensions at every usage boundary. */
export const UsageCounter = z
  .object({
    usageScope: z.enum(["agent", "provider_session", "model_session"]).optional(),
    counterKey: id.optional(),
  })
  .refine(
    (usage) =>
      usage.usageScope === undefined ||
      usage.usageScope === "agent" ||
      usage.counterKey !== undefined,
    { message: "Inclusive usage snapshots require a counter key", path: ["counterKey"] },
  )
  .meta({
    "x-ace-constraint":
      "If usageScope is provider_session or model_session, counterKey is required.",
  });
export const UsageMetadata = UsageCounter.safeExtend({
  /** Latest occupied context, including cached input, never lifetime totals. */
  contextTokens: tokens.optional(),
  contextSessionId: id.optional(),
  reasoningTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  cacheWrite1hTokens: tokens.optional(),
  model: z.string().min(1).optional(),
  accountId: id.optional(),
  billingMode: z.enum(["api", "subscription", "unknown"]).optional(),
  counterMode: z.enum(["cumulative", "incremental"]).optional(),
}).meta(UsageCounter.meta() ?? {});
export type UsageMetadata = z.infer<typeof UsageMetadata>;
