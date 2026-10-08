import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import {
  initialQuota,
  ingestQuota,
  openRegistry,
  createInstance,
  AccountService,
} from "./index.ts";
import { quotaPayload, temp, cleanup } from "./test-support.ts";
afterEach(cleanup);
const now = Date.parse("2026-10-02T00:00Z");

it("recorded Codex and Claude windows expose remaining amounts, resets and provenance", async () => {
  for (const [provider, path] of [
    ["codex", "fixtures/codex/0.159.1/tool-read.jsonl"],
    ["claude", "fixtures/claude/2.1.286/subagent.jsonl"],
  ] as const) {
    let state: ReturnType<typeof initialQuota> = { ...initialQuota(), auth: "logged_in" as const };
    const stream = createReadStream(new URL(`../../../${path}`, import.meta.url));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const frame = z.object({ data: z.unknown().optional() }).parse(JSON.parse(line));
        if (frame.data === undefined) continue;
        state = ingestQuota(state, {
          provider,
          payload: quotaPayload(frame.data),
          observedAt: now,
          timeZone: "UTC",
        }).state;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (provider === "codex") {
      expect(state.windows["codex:primary"]).toMatchObject({
        usedPercent: 33,
        remainingPercent: 67,
        windowDurationMins: 10080,
        resetsAt: 1791047640000,
        source: "cli",
      });
      expect(state.plan).toBe("pro");
    } else {
      expect(state.windows["five_hour"]).toMatchObject({
        remainingPercent: 83,
        resetsAt: 1790935800000,
        source: "cli",
      });
      expect(state.windows["seven_day"]).toMatchObject({ remainingPercent: 31, source: "cli" });
    }
  }
});

it("status-only warnings are estimates and unknown upstreams do not acquire invented quotas", () => {
  const warning = ingestQuota(initialQuota(), {
    provider: "claude",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" },
    }),
  }).state;
  expect(warning.windows["five_hour"]).toMatchObject({
    usedPercent: 80,
    source: "status_estimate",
  });
  expect(warning.windows["five_hour"]?.remainingPercent).toBeUndefined();
  const go = ingestQuota(initialQuota(), {
    provider: "opencode",
    observedAt: now,
    timeZone: "UTC",
    payload: quotaPayload({ upstream: "go", future: { quota: 100 } }),
  }).state;
  expect(go.windows).toEqual({});
});

it("committed quota changes notify readers once, preserve account isolation and survive restart", async () => {
  const home = await temp();
  const path = join(home, "accounts.sqlite");
  let registry = await openRegistry(path);
  try {
    for (const id of ["a", "b"])
      await registry.register(
        createInstance({ id, provider: "codex", label: id, homeDir: join(home, id) }),
      );
    const service = new AccountService({ registry, now: () => now, timeZone: "UTC", env: {} });
    const pushed: unknown[] = [];
    const stop = service.subscribeQuota((account) => pushed.push(account));
    const payload = quotaPayload({
      auth: "logged_in",
      authDetail: "API key",
      rateLimits: { primary: { usedPercent: 100, resetsAt: (now + 3600000) / 1000 } },
    });
    const fact = { provider: "codex" as const, payload, observedAt: now, timeZone: "UTC" };
    registry.ingest("a", fact);
    registry.ingest("a", { ...fact, observedAt: now + 1 });
    expect(pushed).toEqual([
      expect.objectContaining({
        id: "a",
        availability: "exhausted",
        blockedUntil: now + 3600000,
        quota: expect.objectContaining({ billingMode: "api" }),
      }),
    ]);
    registry.ingest("a", {
      ...fact,
      observedAt: now - 1,
      payload: quotaPayload({ rateLimits: { primary: { usedPercent: 0 } } }),
    });
    expect(pushed).toHaveLength(1);
    expect(registry.summary("b", now)?.quota.windows).toEqual({});
    stop();
    registry.close();
    registry = await openRegistry(path);
    expect(registry.summary("a", now)).toMatchObject({
      blockedUntil: now + 3600000,
      quota: { billingMode: "api" },
    });
    expect(registry.summary("a", now + 3600000)?.availability).toBe("available");
  } finally {
    registry.close();
  }
});
