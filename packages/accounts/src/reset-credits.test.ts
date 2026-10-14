import { expect, test } from "vitest";
import type { AccountQuota } from "@ace/protocol/accounts";
import { ingestQuota, initialQuota } from "./index.ts";
import { quotaPayload } from "./test-support.ts";

const now = Date.parse("2026-10-13T15:00:00Z");
const login: AccountQuota = { ...initialQuota(), auth: "logged_in" };
const ingest = (state: AccountQuota, payload: unknown, provider: "codex" | "claude" = "codex") =>
  ingestQuota(state, {
    provider,
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload(payload),
  }).state;

/** `account/rateLimits/read` as Codex 0.162 answers it, wrapped in ace's note frame. */
const usageRead = {
  event: "account-rate-limits",
  rateLimits: { limitId: "codex", primary: { usedPercent: 12, resetsAt: now / 1000 + 3600 } },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 },
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 },
    },
  },
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [
      { id: "a", status: "available", resetType: "codexRateLimits", grantedAt: 1, expiresAt: null },
      {
        id: "b",
        status: "available",
        resetType: "codexRateLimits",
        grantedAt: 1,
        expiresAt: now / 1000 + 7 * 86400,
      },
      { id: "c", status: "redeemed", resetType: "codexRateLimits", grantedAt: 1, expiresAt: 5 },
    ],
  },
};

test("a Codex usage read reports banked resets with their soonest expiry", () => {
  const state = ingest(login, usageRead);
  expect(state.resetCredits).toEqual({ available: 3, nextExpiresAt: now + 7 * 86_400_000 });
});

test("sparse rate-limit updates keep the banked resets the last full read reported", () => {
  const read = ingest(login, usageRead);
  const updated = ingest(read, {
    method: "account/rateLimits/updated",
    params: { rateLimits: { limitId: "codex", primary: { usedPercent: 30, resetsAt: null } } },
  });
  expect(updated.resetCredits?.available).toBe(3);
  const spent = ingest(updated, { ...usageRead, rateLimitResetCredits: { availableCount: 0 } });
  expect(spent.resetCredits).toEqual({ available: 0, nextExpiresAt: null });
});

test("a model-specific Codex limit keeps the provider's name for it", () => {
  const state = ingest(login, usageRead);
  expect(state.windows["codex_bengalfox:primary"]?.limitName).toBe("GPT-5.3-Codex-Spark");
  expect(state.windows["codex:secondary"]?.limitName).toBeUndefined();
});

test("Claude reports no banked resets, so none are recorded", () => {
  const state = ingest(
    login,
    {
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.2,
        resetsAt: now / 1000 + 3600,
      },
      rateLimitResetCredits: { availableCount: 2 },
    },
    "claude",
  );
  expect(state.resetCredits).toBeUndefined();
  expect(state.windows["five_hour"]?.usedPercent).toBe(20);
});
