import { expect, test } from "vitest";
import { readClaudeUsage } from "./usage-read.ts";

/** `SDKControlGetUsageResponse` as the Agent SDK 0.3.288 types declare it, for a Max login. */
const maxLogin = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: "2026-10-15T18:00:00.000Z" },
    seven_day: { utilization: 12.5, resets_at: "2026-10-20T09:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: null, resets_at: null },
    model_scoped: [{ display_name: "Opus", utilization: 3, resets_at: null }],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  },
  behaviors: null,
};

async function read(answer: () => Promise<unknown>) {
  const emitted: Record<string, unknown>[] = [];
  readClaudeUsage({
    query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: answer },
    emit: (data) => emitted.push(data),
    isClosed: () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return emitted;
}

test("Claude's plan limits read as measured windows with their resets and the plan", async () => {
  expect(await read(async () => maxLogin)).toEqual([
    {
      event: "claude-usage",
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-10-15T18:00:00.000Z" },
        seven_day: { utilization: 12.5, resets_at: "2026-10-20T09:00:00.000Z" },
      },
      planType: "max",
    },
  ]);
});

test("an API-key login, a failed read or an SDK without the method reports no limits", async () => {
  expect(
    await read(async () => ({ ...maxLogin, subscription_type: null, rate_limits: null })),
  ).toEqual([]);
  expect(await read(async () => Promise.reject(new Error("offline")))).toEqual([]);
  const emitted: unknown[] = [];
  readClaudeUsage({ query: {}, emit: (data) => emitted.push(data), isClosed: () => false });
  expect(emitted).toEqual([]);
});
