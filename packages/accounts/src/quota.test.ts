import { quotaPayload } from "./test-support.ts";
import { afterEach, expect, test } from "vitest";
import {
  initialQuota,
  ingestQuota,
  availability,
  parseLimitReset,
  openRegistry,
  createInstance,
  pickInstance,
  speedHint,
} from "./index.ts";
import { join } from "node:path";
import { temp, cleanup } from "./test-support.ts";
import type { AccountQuota } from "@ace/protocol/accounts";
afterEach(cleanup);
const instance = (id: string) =>
  createInstance({ id, provider: "codex", label: id, homeDir: `/tmp/${id}` });
const now = Date.parse("2026-10-02T15:00:00Z");
const login: AccountQuota = { ...initialQuota(), auth: "logged_in" };
function codex(
  state: AccountQuota,
  percent: number,
  at = now,
  resetsAt: number | null = (now + 3600000) / 1000,
) {
  return ingestQuota(state, {
    provider: "codex",
    observedAt: at,
    timeZone: "America/Chicago",
    payload: quotaPayload({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: percent, resetsAt, unknown: "preserved" } } },
    }),
  }).state;
}
test("Codex moves through available, near-limit and exhausted until the exact reset", () => {
  const available = codex(login, 20);
  expect(availability(available, now)).toBe("available");
  expect(availability(codex(available, 80), now)).toBe("near_limit");
  const exhausted = codex(available, 100);
  expect(availability(exhausted, now + 3599999)).toBe("exhausted");
  expect(availability(exhausted, now + 3600000)).toBe("available");
});
test("a later reset on a second window keeps the account exhausted", () => {
  const result = ingestQuota(login, {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 100, resetsAt: now / 1000 + 1 },
          secondary: { usedPercent: 100, resetsAt: now / 1000 + 100 },
        },
      },
    }),
  });
  expect(availability(result.state, now + 2000)).toBe("exhausted");
  expect(availability(result.state, now + 100000)).toBe("available");
});
test("Claude event fractions and usage snapshot percentages produce the same warning", () => {
  const event = ingestQuota(login, {
    provider: "claude",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        utilization: 0.85,
        resetsAt: now / 1000 + 3600,
        rateLimitType: "five_hour",
      },
    }),
  });
  expect(availability(event.state, now)).toBe("near_limit");
  const snapshot = ingestQuota(login, {
    provider: "claude",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      rate_limits: { five_hour: { utilization: 85, resets_at: "2026-10-02T16:00:00Z" } },
      session: { total_cost_usd: 2 },
    }),
  });
  expect(availability(snapshot.state, now)).toBe("near_limit");
  expect(availability(snapshot.state, now + 3600000)).toBe("available");
});
test("a rejection without utilization blocks even without a known reset", () => {
  const state = ingestQuota(login, {
    provider: "claude",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({ rate_limit_info: { status: "rejected" } }),
  }).state;
  expect(availability(state, now + 86400000)).toBe("exhausted");
});
test("logged-out accounts stay unavailable even when quota has reset", () => {
  const state = ingestQuota(codex(login, 100), {
    provider: "codex",
    observedAt: now + 1,
    timeZone: "UTC",
    payload: quotaPayload({ auth: "logged_out" }),
  }).state;
  expect(availability(state, now + 86400000)).toBe("logged_out");
});
test("old rate-limit updates cannot restore a newly exhausted account", () => {
  const exhausted = codex(login, 100);
  expect(availability(codex(exhausted, 0, now - 1), now)).toBe("exhausted");
});
test("unknown and malformed facts return raw unchanged and do not reset quota", () => {
  const state = codex(login, 100);
  const payload = {
    method: "future",
    params: { rateLimits: { primary: { usedPercent: "oops" } }, secret: { future: true } },
  };
  const result = ingestQuota(state, {
    provider: "codex",
    observedAt: now + 1,
    timeZone: "UTC",
    payload: quotaPayload(payload),
  });
  expect(result.raw).toEqual(payload);
  expect(result.state).toBe(state);
});
test("limit error clock text resolves in the user's timezone, including midnight", () => {
  expect(
    parseLimitReset("Usage limit reached. Try again at 11:31 AM", now, "America/Chicago"),
  ).toBe(Date.parse("2026-10-02T16:31:00Z"));
  expect(parseLimitReset("Usage limit reached. Try again at 11:31 AM", now, "Asia/Kolkata")).toBe(
    Date.parse("2026-10-03T06:01:00Z"),
  );
  expect(parseLimitReset("resets 12:01 AM (America/Chicago)", now, "UTC")).toBe(
    Date.parse("2026-10-03T05:01:00Z"),
  );
  const state = ingestQuota(login, {
    provider: "codex",
    observedAt: now,
    timeZone: "America/Chicago",
    payload: quotaPayload({ message: "Usage limit reached. Try again at 11:31 AM" }),
  }).state;
  expect(availability(state, Date.parse("2026-10-02T16:30:00Z"))).toBe("exhausted");
  expect(availability(state, Date.parse("2026-10-02T16:31:00Z"))).toBe("available");
});
test("ambiguous and nonexistent DST times stay blocked rather than guessing", () => {
  expect(
    parseLimitReset("try again at 1:30 AM", Date.parse("2026-11-01T04:00:00Z"), "America/Chicago"),
  ).toBeNull();
  expect(
    parseLimitReset("try again at 2:30 AM", Date.parse("2026-03-08T06:00:00Z"), "America/Chicago"),
  ).toBeNull();
  expect(parseLimitReset("try again at 25:30 AM", now, "UTC")).toBeNull();
  expect(parseLimitReset("try again at 2026-10-02T16:00:00-05:00", now, "UTC")).toBe(
    Date.parse("2026-10-02T21:00:00Z"),
  );
});
test("the scheduler spends quota that resets soonest while excluding near limits and insufficient headroom", () => {
  const candidates = [
    { instance: instance("late"), quota: codex(login, 10, now, now / 1000 + 500) },
    { instance: instance("early"), quota: codex(login, 60, now, now / 1000 + 100) },
    { instance: instance("near"), quota: codex(login, 80, now, now / 1000 + 10) },
  ];
  expect(
    pickInstance({ provider: "codex", role: "worker", estimatedLoad: 20 }, candidates, now)?.id,
  ).toBe("early");
  expect(
    pickInstance({ provider: "codex", role: "worker", estimatedLoad: 50 }, candidates, now)?.id,
  ).toBe("late");
  expect(
    pickInstance({ provider: "claude", role: "worker", estimatedLoad: 1 }, candidates, now),
  ).toBeUndefined();
  expect(
    pickInstance(
      { provider: "codex", role: "worker", estimatedLoad: 1 },
      [{ instance: instance("out"), quota: { ...login, auth: "logged_out" } }],
      now,
    ),
  ).toBeUndefined();
});
test("scheduler ties use headroom then stable identity, and expired windows no longer consume headroom", () => {
  const candidates = [
    { instance: instance("z"), quota: codex(login, 70) },
    { instance: instance("a"), quota: codex(login, 10) },
    { instance: instance("b"), quota: codex(login, 10) },
  ];
  expect(
    pickInstance({ provider: "codex", role: "worker", estimatedLoad: 10 }, candidates, now)?.id,
  ).toBe("a");
  expect(
    pickInstance(
      { provider: "codex", role: "worker", estimatedLoad: 100 },
      candidates,
      now + 3600000,
    )?.id,
  ).toBe("a");
  expect(() =>
    pickInstance({ provider: "codex", role: "worker", estimatedLoad: NaN }, candidates, now),
  ).toThrow();
});
test("fast roles only request speed tiers advertised for the selected model", () => {
  const policy = { worker: { speed: "fast" as const }, reviewer: { speed: "standard" as const } };
  const capabilities = {
    codexModelList: {
      data: [
        { model: "fast-model", serviceTiers: [{ id: "priority" }] },
        { model: "slow-model", serviceTiers: [] },
      ],
    },
    claudeFastModels: ["opus"],
  };
  expect(speedHint("codex", "worker", "fast-model", policy, capabilities)).toEqual({
    service_tier: "priority",
  });
  expect(speedHint("codex", "worker", "slow-model", policy, capabilities)).toEqual({});
  expect(speedHint("codex", "reviewer", "fast-model", policy, capabilities)).toEqual({});
  expect(speedHint("claude", "worker", "opus", policy, capabilities)).toEqual({ fastMode: true });
  expect(speedHint("claude", "worker", "sonnet", policy, capabilities)).toEqual({});
});
test("quota and login state survive reopening SQLite and remain isolated by instance", async () => {
  const path = join(await temp(), "accounts.sqlite");
  let registry = await openRegistry(path);
  for (const id of ["a", "b"])
    await registry.register(
      createInstance({ id, provider: "codex", label: id, homeDir: `/tmp/${id}` }),
    );
  registry.ingest("a", {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      auth: "logged_in",
      rateLimits: { primary: { usedPercent: 100, resetsAt: now / 1000 + 100 } },
    }),
  });
  registry.ingest("b", {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({ auth: "logged_in" }),
  });
  registry.close();
  registry = await openRegistry(path);
  expect(
    registry.pickInstance({ provider: "codex", role: "worker", estimatedLoad: 1 }, now)?.id,
  ).toBe("b");
  expect(registry.summaries(now).find((a) => a.id === "a")?.availability).toBe("exhausted");
  expect(JSON.stringify(registry.summaries(now))).not.toContain("homeDir");
  registry.close();
});

test("recorded provider rate-limit payloads retain all windows and their measured usage", async () => {
  const { readFile } = await import("node:fs/promises");
  const claude: unknown = JSON.parse(
    await readFile(new URL("./__fixtures__/claude-rate-limit.json", import.meta.url), "utf8"),
  );
  const codexPayload: unknown = JSON.parse(
    await readFile(new URL("./__fixtures__/codex-rate-limit.json", import.meta.url), "utf8"),
  );
  const at = Date.parse("2026-10-02T01:00:00Z");
  const c = ingestQuota(login, {
    provider: "claude",
    payload: quotaPayload(claude),
    observedAt: at,
    timeZone: "UTC",
  }).state;
  expect(c.windows["five_hour"]?.usedPercent).toBe(17);
  expect(c.windows["seven_day"]?.usedPercent).toBe(69);
  const x = ingestQuota(login, {
    provider: "codex",
    payload: quotaPayload(codexPayload),
    observedAt: at,
    timeZone: "UTC",
  }).state;
  expect(x.windows["codex:primary"]?.usedPercent).toBe(33);
  // Once the five-hour window expires, the weekly window still constrains load.
  expect(
    pickInstance(
      { provider: "claude", role: "worker", estimatedLoad: 40 },
      [
        {
          instance: createInstance({ id: "c", provider: "claude", label: "c", homeDir: "/tmp/c" }),
          quota: c,
        },
      ],
      Date.parse("2026-10-02T09:00:00Z"),
    ),
  ).toBeUndefined();
});
test("fresh quota facts recover a resetless textual limit, and usage counters are cumulative snapshots", () => {
  const limited = ingestQuota(login, {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({ message: "Usage limit reached" }),
  }).state;
  expect(availability(limited, now)).toBe("exhausted");
  expect(availability(codex(limited, 10, now + 1), now + 1)).toBe("available");
  const a = ingestQuota(login, {
    provider: "claude",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      session: { total_cost_usd: 2 },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }).state;
  const b = ingestQuota(a, {
    provider: "claude",
    observedAt: now + 1,
    timeZone: "UTC",
    payload: quotaPayload({ total_cost_usd: 3, usage: { input_tokens: 15, output_tokens: 6 } }),
  }).state;
  expect(b.usage).toEqual({ costUsd: 3, inputTokens: 15, outputTokens: 6 });
});

test("window overflow stays bounded and blocks scheduling until an authoritative bounded snapshot", () => {
  const windows = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `limit-${index}`,
      { primary: { usedPercent: index === 39 ? 100 : 5, resetsAt: now / 1000 + 3600 } },
    ]),
  );
  const state = ingestQuota(login, {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({ rateLimitsByLimitId: windows }),
  }).state;
  expect(Object.keys(state.windows).length).toBeLessThanOrEqual(32);
  expect(availability(state, now + 86400000)).toBe("exhausted");
  const recovered = ingestQuota(state, {
    provider: "codex",
    observedAt: now + 1,
    timeZone: "UTC",
    payload: quotaPayload({
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, resetsAt: now / 1000 + 3600 } } },
    }),
  }).state;
  expect(availability(recovered, now + 1)).toBe("available");
});
