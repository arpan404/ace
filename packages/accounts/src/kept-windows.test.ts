import { expect, test } from "vitest";
import type { AccountQuota } from "@ace/protocol/accounts";
import { availability, ingestQuota, initialQuota } from "./index.ts";
import { quotaPayload } from "./test-support.ts";

/*
 * Shapes recorded on a real Mac on 2026-10-14 (ids, account ids and credit ids scrubbed):
 * Codex 0.162 `account/rateLimits/read` for a Plus login, and Claude Code 2.1.296
 * `rate_limit_event` frames.
 */
const now = Date.parse("2026-10-14T03:30:00Z");
const s = (at: number) => Math.round(at / 1000);
const hour = 3_600_000;
const login: AccountQuota = { ...initialQuota(), auth: "logged_in" };
const ingest = (
  state: AccountQuota,
  payload: unknown,
  at = now,
  provider: "codex" | "claude" = "codex",
) =>
  ingestQuota(state, { provider, observedAt: at, timeZone: "UTC", payload: quotaPayload(payload) })
    .state;

const plusReadAt = (at: number) => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: s(at + 5 * hour) },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: s(at + 6 * 24 * hour) },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: s(at + 5 * hour) },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: s(at + 6 * 24 * hour) },
      planType: "plus",
    },
  },
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [1, 2, 3].map((n) => ({
      id: `credit-${n}`,
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: s(at - 20 * 24 * hour),
      expiresAt: s(at + n * 7 * 24 * hour),
      title: "Full reset (Weekly + 5 hr)",
      description: "Granted one free rate limit reset.",
    })),
  },
  accountId: "account-scrubbed",
  rateLimitUpsell: null,
  event: "account-rate-limits",
});
const plusRead = plusReadAt(now);

test("a Codex Plus usage read records its 5-hour and weekly windows and 3 banked resets", () => {
  const state = ingest(login, plusRead);
  expect(state.windows["codex:primary"]).toMatchObject({
    usedPercent: 0,
    windowDurationMins: 300,
    observedAt: now,
  });
  expect(state.windows["codex:secondary"]?.windowDurationMins).toBe(10080);
  expect(state.resetCredits).toEqual({
    available: 3,
    nextExpiresAt: s(now + 7 * 24 * hour) * 1000,
  });
});

test("a window stays after its reset passes, with when it was read, until a newer reading", () => {
  const read = ingest(login, plusReadAt(now - 6 * hour), now - 6 * hour);
  // A later fact without windows (an auth check at daemon start) leaves the old 5-hour reading.
  const later = ingest(read, { auth: "logged_in" }, now);
  expect(later.windows["codex:primary"]?.observedAt).toBe(now - 6 * hour);
  expect(later.windows["codex:primary"]?.resetsAt).toBeLessThan(now);
  // A reading past its reset never blocks the account.
  expect(availability(later, now)).toBe("available");
  expect(ingest(later, plusRead, now).windows["codex:primary"]?.observedAt).toBe(now);
});

test("Claude's windows from separate events add up, the Fable weekly window included", () => {
  const event = (type: string, utilization: number, resetsIn: number) => ({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: s(now + resetsIn),
      rateLimitType: type,
      utilization,
      overageStatus: "rejected",
      isUsingOverage: false,
    },
    session_id: "session-scrubbed",
  });
  const first = ingest(login, event("five_hour", 0.91, 2 * hour), now - hour, "claude");
  const second = ingest(
    first,
    event("seven_day", 0.64, 3 * 24 * hour),
    now - 30 * 60_000,
    "claude",
  );
  const third = ingest(
    second,
    event("seven_day_overage_included", 0.27, 3 * 24 * hour),
    now,
    "claude",
  );
  expect(Object.keys(third.windows).toSorted()).toEqual([
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
  ]);
  expect(third.windows["seven_day_overage_included"]?.usedPercent).toBe(27);
  expect(third.windows["five_hour"]?.observedAt).toBe(now - hour);
});
