import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createInstance, openRegistry, type AccountRegistry } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { refreshCodexLimits, type ReadCodexUsage } from "./account-limits.ts";

const now = Date.parse("2026-10-14T03:30:00Z");
const hour = 3_600_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function registry(): Promise<{ registry: AccountRegistry; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "ace-limits-"));
  const opened = await openRegistry(join(home, "accounts.sqlite"));
  cleanups.push(async () => {
    opened.close();
    await rm(home, { recursive: true, force: true });
  });
  for (const id of ["plus", "free", "signed-out"]) {
    await mkdir(join(home, id));
    await opened.register(
      createInstance({ id, provider: "codex", label: id, homeDir: join(home, id) }),
    );
    opened.ingest(id, {
      provider: "codex",
      payload: new ProviderPayload(
        JSON.stringify({ auth: id === "signed-out" ? "logged_out" : "logged_in" }),
      ),
      observedAt: now - hour,
      timeZone: "UTC",
    });
  }
  return { registry: opened, home };
}

/** Recorded `account/rateLimits/read` shapes (scrubbed): a Plus login and a free one. */
const reads: Record<string, Record<string, unknown>> = {
  plus: {
    rateLimits: { limitId: "codex", primary: null, secondary: null },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: (now + 5 * hour) / 1000 },
        secondary: {
          usedPercent: 0,
          windowDurationMins: 10080,
          resetsAt: (now + 150 * hour) / 1000,
        },
      },
    },
    rateLimitResetCredits: { availableCount: 3, credits: null },
  },
  free: {
    rateLimits: { limitId: "codex" },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 2, windowDurationMins: 43200, resetsAt: (now + 700 * hour) / 1000 },
        secondary: null,
      },
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  },
};

test("refreshing limits records every signed-in Codex account's windows and banked resets", async () => {
  const { registry: accounts, home } = await registry();
  const asked: string[] = [];
  const read: ReadCodexUsage = async ({ env }) => {
    const id = env["CODEX_HOME"]?.split("/").at(-1) ?? "";
    asked.push(id);
    const result = reads[id];
    if (!result) throw new Error("not signed in");
    return result;
  };
  await refreshCodexLimits({
    registry: accounts,
    env: {},
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    read,
  });

  expect(asked.toSorted()).toEqual(["free", "plus"]);
  const plus = accounts.get("plus")?.quota;
  expect(Object.values(plus?.windows ?? {}).map((window) => window.windowDurationMins)).toEqual([
    300, 10080,
  ]);
  expect(plus?.resetCredits?.available).toBe(3);
  const free = accounts.get("free")?.quota;
  expect(Object.values(free?.windows ?? {}).map((window) => window.windowDurationMins)).toEqual([
    43200,
  ]);
  expect(free?.resetCredits?.available).toBe(0);
});

test("one account whose limits can't be read leaves the others recorded", async () => {
  const { registry: accounts, home } = await registry();
  const failed: string[] = [];
  await refreshCodexLimits({
    registry: accounts,
    env: {},
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    read: async ({ env }) => {
      const id = env["CODEX_HOME"]?.split("/").at(-1) ?? "";
      if (id === "free") throw new Error("Codex is offline");
      return reads[id] ?? {};
    },
    onError: (instance) => failed.push(instance),
  });
  expect(failed).toEqual(["free"]);
  expect(accounts.get("plus")?.quota.resetCredits?.available).toBe(3);
});
