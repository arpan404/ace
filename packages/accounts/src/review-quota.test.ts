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
test("inherited names cannot exceed the retained window cap or reject registry ingestion", async () => {
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
    expect(registry.summaries(now)[0]?.availability).toBe("exhausted");
  } finally {
    registry.close();
  }
});
test("provider names cannot overwrite synthetic overflow exhaustion", () => {
  const rate_limits = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`w${i}`, { utilization: 0 }]),
  );
  const exhausted = fold({ rate_limits }).state;
  expect(
    availability(
      fold(
        { rate_limit_info: { status: "allowed", rateLimitType: "quota_overflow", utilization: 0 } },
        exhausted,
      ).state,
      now,
    ),
  ).toBe("exhausted");
});
test("incremental updates to an existing window preserve overflow until a complete snapshot", () => {
  const rate_limits = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`w${i}`, { utilization: 0 }]),
  );
  const exhausted = fold({ rate_limits }).state;
  const incremental = fold(
    {
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "w0",
        utilization: 0,
      },
    },
    exhausted,
  ).state;
  expect(availability(incremental, now)).toBe("exhausted");
  expect(
    availability(fold({ rate_limits: { w0: { utilization: 0 } } }, incremental).state, now),
  ).toBe("available");
});
test("bounded quota folding retains admitted raw identity while overflow blocks scheduling", () => {
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
  expect(availability(result.state, now)).toBe("exhausted");
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
    { message: "Usage limit reached", rateLimits: { primary: { usedPercent: 0 } } },
    logged,
    "codex",
  );
  expect(availability(result.state, now)).toBe("exhausted");
});
test("malformed windows consume the ingress budget before a tail window can restore availability", () => {
  const rate_limits: Record<string, unknown> = {};
  for (let i = 0; i < 32; i++) rate_limits[`bad${i}`] = { utilization: "invalid" };
  rate_limits["tail"] = { utilization: 0 };
  const result = fold({ rate_limits });
  expect(result.state.windows["tail"]).toBeUndefined();
  expect(availability(result.state, now)).toBe("exhausted");
});
test("reopening an old registry upgrades exhaustion without losing account state", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await temp();
  const path = join(root, "accounts.sqlite");
  let registry = await openRegistry(path);
  await registry.register(
    createInstance({ id: "a", provider: "codex", label: "a", homeDir: join(root, "home") }),
  );
  registry.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE accounts SET quota=? WHERE id=?").run(
    JSON.stringify({
      auth: "logged_in",
      observedAt: now,
      windows: { quota_overflow: { usedPercent: 100, resetsAt: null } },
      usage: { inputTokens: 12 },
    }),
    "a",
  );
  db.close();
  registry = await openRegistry(path);
  try {
    expect(registry.summaries(now)[0]?.availability).toBe("exhausted");
    expect(registry.summaries(now)[0]?.quota.usage.inputTokens).toBe(12);
    const next = registry.ingest("a", {
      provider: "codex",
      payload: quotaPayload({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } } } }),
      observedAt: now + 1,
      timeZone: "UTC",
    });
    expect(availability(next.state, now + 1)).toBe("available");
  } finally {
    registry.close();
  }
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
  await expect(openRegistry(path)).rejects.toThrow("distinct");
});
test("unknown facts preserve a textual blocker and its last meaningful observation", () => {
  const state = fold({ message: "Usage limit reached" }).state;
  const payload = { future: true };
  const result = ingestQuota(state, {
    provider: "claude",
    payload: quotaPayload(payload),
    observedAt: now + 1,
    timeZone: "UTC",
  });
  expect(result.state).toBe(state);
  expect(result.raw).toEqual(payload);
  expect(availability(result.state, now + 1)).toBe("exhausted");
});
