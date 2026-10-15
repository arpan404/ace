import { z } from "zod";
import { askClaude, type MetadataQueryInput } from "./metadata-query.ts";

/*
 * Claude Code's plan limits through the SDK's `get_usage` control request
 * (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). The CLI asks claude.ai's usage
 * endpoint with its own login, renewing it itself: no prompt, no quota, and ace never sees a
 * credential. It is read when a session opens and, between sessions, by a short-lived
 * initialization-only query; the CLI's `rate_limit_event` frames keep the windows current
 * during turns.
 */

const reset = z.string().max(64).nullable().optional();
const window = z.object({
  utilization: z.number().finite().nonnegative().nullable(),
  resets_at: reset,
});
/** A model's own weekly limit ("Fable"), beside the shared weekly window. */
const modelWindow = z.object({
  display_name: z.string().trim().min(1).max(64),
  utilization: z.number().finite().nonnegative().nullable(),
  resets_at: reset,
});
const UsageResponse = z.object({
  subscription_type: z.string().min(1).max(128).nullable().optional(),
  rate_limits: z.record(z.string().max(128), z.unknown()).nullable().optional(),
});
/** The account's own windows, by the names Claude gives them, and how long each runs. */
const windowLengths = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_oauth_apps: 10080,
} as const;

type Window = {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number;
  limitName?: string;
  advisory?: true;
};

const instant = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};
const percent = (value: number) => Math.min(100, value);

/**
 * The reading as a quota frame in ace's neutral form (`usageWindows`: percent used, epoch-ms
 * reset), and the plan. The session and weekly windows stop all work when full; a model's own
 * weekly limit stops only that model, so it never holds the account.
 */
export function usageReading(result: unknown): Record<string, unknown> | undefined {
  const parsed = UsageResponse.safeParse(result).data;
  if (!parsed?.rate_limits) return undefined;
  const usageWindows: Record<string, Window> = {};
  for (const [name, minutes] of Object.entries(windowLengths)) {
    const reading = window.safeParse(parsed.rate_limits[name]).data;
    // An absent or unmeasured window says nothing about the limit, so it is left out.
    if (reading?.utilization == null) continue;
    usageWindows[name] = {
      usedPercent: percent(reading.utilization),
      resetsAt: instant(reading.resets_at),
      windowDurationMins: minutes,
    };
  }
  const scoped = z.array(z.unknown()).max(16).safeParse(parsed.rate_limits["model_scoped"]).data;
  for (const entry of scoped ?? []) {
    const reading = modelWindow.safeParse(entry).data;
    if (reading?.utilization == null) continue;
    usageWindows[`seven_day_model:${reading.display_name}`] = {
      usedPercent: percent(reading.utilization),
      resetsAt: instant(reading.resets_at),
      windowDurationMins: 10080,
      limitName: reading.display_name,
      advisory: true,
    };
  }
  if (!Object.keys(usageWindows).length) return undefined;
  return {
    event: "claude-usage",
    usageWindows,
    ...(parsed.subscription_type ? { planType: parsed.subscription_type } : {}),
  };
}

/** The SDK query's experimental usage read, when this SDK has it. */
type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
    skipBehaviors?: boolean;
  }) => Promise<unknown>;
};

const ask = (query: UsageQuery): Promise<unknown> => {
  const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  return typeof read === "function"
    ? read.call(query, { skipBehaviors: true })
    : Promise.resolve(undefined);
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
  ask(options.query).then(
    (result) => {
      const reading = usageReading(result);
      if (reading && !options.isClosed()) options.emit(reading);
    },
    () => undefined,
  );
}

/**
 * One account's plan limits without a session: an initialization-only query asks, then the CLI
 * exits. Undefined when the login has no plan limits (an API key) or the SDK can't say. Errors
 * are fixed words: the CLI's output never reaches them.
 */
export async function readClaudePlanUsage(
  input: MetadataQueryInput & { timeoutMs?: number },
): Promise<Record<string, unknown> | undefined> {
  const { timeoutMs = 20_000, ...query } = input;
  let result: unknown;
  try {
    // A CLI that never answers is stopped, so a refresh never waits on it for good.
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
    result = await askClaude({ ...query, signal }, "usage read", ask);
  } catch {
    input.signal.throwIfAborted();
    throw new Error("Claude Code usage is unavailable");
  }
  return usageReading(result);
}
