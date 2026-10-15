import { z } from "zod";

/*
 * Claude Code's plan limits, read once a session opens through the SDK's `get_usage` control
 * request (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). The CLI asks claude.ai's
 * usage endpoint with its own login: no prompt, no quota, and ace never sees a credential.
 * Between opens, the CLI's `rate_limit_event` frames keep the windows current during turns.
 */

const window = z.object({
  utilization: z.number().finite().nonnegative().nullable(),
  resets_at: z.string().max(64).nullable(),
});
const UsageResponse = z.object({
  subscription_type: z.string().min(1).max(128).nullable().optional(),
  rate_limits: z.record(z.string().max(128), z.unknown()).nullable().optional(),
});
/** Named windows only; `model_scoped` and `extra_usage` are other shapes and stay out. */
const windowNames = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

/** The reading as a quota frame: `rate_limits` windows in percent used, and the plan. */
export function usageReading(result: unknown): Record<string, unknown> | undefined {
  const parsed = UsageResponse.safeParse(result).data;
  if (!parsed?.rate_limits) return undefined;
  const rate_limits: Record<string, { utilization: number; resets_at: string | null }> = {};
  for (const name of windowNames) {
    const reading = window.safeParse(parsed.rate_limits[name]).data;
    // An absent or unmeasured window says nothing about the limit, so it is left out.
    if (reading?.utilization == null) continue;
    rate_limits[name] = { utilization: reading.utilization, resets_at: reading.resets_at };
  }
  if (!Object.keys(rate_limits).length) return undefined;
  return {
    event: "claude-usage",
    rate_limits,
    ...(parsed.subscription_type ? { planType: parsed.subscription_type } : {}),
  };
}

/** The SDK query's experimental usage read, when this SDK has it. */
type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
    skipBehaviors?: boolean;
  }) => Promise<unknown>;
};

/**
 * Ask once and emit what came back as a `note` frame the account registry folds like any
 * rate-limit report. An SDK without the method, an API-key login (no plan limits) or a failed
 * read changes nothing: no reading is no limit.
 */
export function readClaudeUsage(options: {
  query: UsageQuery;
  emit(data: Record<string, unknown>): void;
  isClosed(): boolean;
}): void {
  const read = options.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof read !== "function") return;
  read.call(options.query, { skipBehaviors: true }).then(
    (result) => {
      const reading = usageReading(result);
      if (reading && !options.isClosed()) options.emit(reading);
    },
    () => undefined,
  );
}
