import { quotaPayload } from "./test-support.ts";
import { afterEach, expect, test } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { initialQuota, ingestQuota, availability, openRegistry, createInstance } from "./index.ts";
import { temp, cleanup } from "./test-support.ts";
afterEach(cleanup);
const now = 1000;
import type { AccountQuota } from "@ace/protocol/accounts";
const logged: AccountQuota = { ...initialQuota(), auth: "logged_in" as const };
const fold = (payload: unknown, state = logged, provider: "claude" | "codex" = "claude") =>
  ingestQuota(state, {
    provider,
    payload: quotaPayload(payload),
    observedAt: now,
    timeZone: "UTC",
  });
test("unknown Claude statuses cannot clear an existing rejection", () => {
  const rejected = fold({ rate_limit_info: { status: "rejected" } }).state;
  expect(
    availability(fold({ rate_limit_info: { status: "future_rejected" } }, rejected).state, now),
  ).toBe("exhausted");
});
test("a malformed authoritative Codex sibling cannot erase the exhausted window", () => {
  const rejected = fold(
    {
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 10 }, secondary: { usedPercent: 100 } },
      },
    },
    logged,
    "codex",
  ).state;
  expect(
    availability(
      fold(
        {
          rateLimitsByLimitId: {
            codex: { primary: { usedPercent: 0 }, secondary: { usedPercent: "bad" } },
          },
        },
        rejected,
        "codex",
      ).state,
      now,
    ),
  ).toBe("exhausted");
});
test("inherited names cannot exceed the retained window cap, reject registry ingestion or read as a limit", async () => {
  const root = await temp();
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  try {
    await registry.register(
      createInstance({ id: "c", provider: "claude", label: "c", homeDir: join(root, "c") }),
    );
    const rate_limits = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`w${i}`, { utilization: 0 }]),
    );
    registry.ingest("c", {
      provider: "claude",
      payload: quotaPayload({ auth: "logged_in", rate_limits }),
      observedAt: now,
      timeZone: "UTC",
    });
    registry.ingest("c", {
      provider: "claude",
      payload: quotaPayload({
        rate_limit_info: { status: "allowed", rateLimitType: "toString", utilization: 0 },
      }),
      observedAt: now,
      timeZone: "UTC",
    });
    expect(Object.keys(registry.summaries(now)[0]?.quota.windows ?? {}).length).toBe(32);
    expect(registry.summaries(now)[0]?.quota.blockers.overflow).toBe(true);
    expect(registry.summaries(now)[0]?.availability).toBe("available");
  } finally {
    registry.close();
  }
});
test("provider names cannot overwrite the local overflow marker", () => {
  const rate_limits = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`w${i}`, { utilization: 0 }]),
  );
  const overflowed = fold({ rate_limits }).state;
  const named = fold(
    { rate_limit_info: { status: "allowed", rateLimitType: "quota_overflow", utilization: 0 } },
    overflowed,
  ).state;
  expect(named.blockers.overflow).toBe(true);
  expect(availability(named, now)).toBe("available");
});
test("incremental updates to an existing window preserve overflow until a complete snapshot", () => {
  const rate_limits = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`w${i}`, { utilization: 0 }]),
  );
  const overflowed = fold({ rate_limits }).state;
  const incremental = fold(
    {
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "w0",
        utilization: 0,
      },
    },
    overflowed,
  ).state;
  expect(incremental.blockers.overflow).toBe(true);
  expect(
    fold({ rate_limits: { w0: { utilization: 0 } } }, incremental).state.blockers.overflow,
  ).toBeUndefined();
});
test("bounded quota folding retains admitted raw identity, and overflow is not a limit", () => {
  const rate_limits = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`w${i}`, { utilization: 0 }]),
  );
  const payload = quotaPayload({ rate_limits });
  const result = ingestQuota(logged, {
    provider: "claude",
    payload,
    observedAt: now,
    timeZone: "UTC",
  });
  expect(result.raw).toBe(payload.data);
  expect(Object.keys(result.state.windows)).toHaveLength(32);
  expect(availability(result.state, now)).toBe("available");
});
test.each([false, true])(
  "physical aliases cannot become independent accounts (missing child %s)",
  async (missing) => {
    const root = await temp();
    const real = join(root, "real");
    const alias = join(root, "alias");
    await mkdir(real);
    await symlink(real, alias);
    const registry = await openRegistry(join(root, "accounts.sqlite"));
    try {
      await registry.register(
        createInstance({
          id: "a",
          provider: "codex",
          label: "a",
          homeDir: missing ? join(real, "new") : real,
        }),
      );
      await expect(
        Promise.resolve().then(() =>
          registry.register(
            createInstance({
              id: "b",
              provider: "codex",
              label: "b",
              homeDir: missing ? join(alias, "new") : alias,
            }),
          ),
        ),
      ).rejects.toThrow("distinct");
      expect(registry.list()).toHaveLength(1);
    } finally {
      registry.close();
    }
  },
);
test("a usage limit error wins over quota windows carried in the same frame", () => {
  const result = fold(
    {
      error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
      rateLimits: { primary: { usedPercent: 0 } },
    },
    logged,
    "codex",
  );
  expect(availability(result.state, now)).toBe("exhausted");
});
test("malformed windows consume the ingress budget, and what was not read is not a limit", () => {
  const rate_limits: Record<string, unknown> = {};
  for (let i = 0; i < 32; i++) rate_limits[`bad${i}`] = { utilization: "invalid" };
  rate_limits["tail"] = { utilization: 0 };
  const result = fold({ rate_limits });
  expect(result.state.windows["tail"]).toBeUndefined();
  expect(availability(result.state, now)).toBe("available");
});
test("reopening a historical registry refuses physical aliases before scheduling", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await temp();
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias);
  const path = join(root, "accounts.sqlite");
  const registry = await openRegistry(path);
  await registry.register(
    createInstance({ id: "a", provider: "codex", label: "a", homeDir: real }),
  );
  registry.close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
    "b",
    JSON.stringify(createInstance({ id: "b", provider: "codex", label: "b", homeDir: alias })),
    JSON.stringify(logged),
  );
  db.close();
  const reopened = await openRegistry(path);
  try {
    expect(reopened.summary("b", now)).toMatchObject({
      availability: "unknown",
      quota: { blockers: { homeUnavailable: "home_conflict" } },
    });
    expect(reopened.summary("a", now)?.quota.blockers.homeUnavailable).toBeUndefined();
  } finally {
    reopened.close();
  }
});
test("unknown facts preserve a provider limit and its last meaningful observation", () => {
  const state = fold(
    { error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } },
    logged,
    "codex",
  ).state;
  const payload = { future: true };
  const result = ingestQuota(state, {
    provider: "codex",
    payload: quotaPayload(payload),
    observedAt: now + 1,
    timeZone: "UTC",
  });
  expect(result.state).toBe(state);
  expect(result.raw).toEqual(payload);
  expect(availability(result.state, now + 1)).toBe("exhausted");
});
