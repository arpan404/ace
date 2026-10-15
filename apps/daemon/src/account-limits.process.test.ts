import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createInstance, openRegistry, type AccountRegistry } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { refreshCliLimits, type ReadCliUsage } from "./account-limits.ts";

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
  for (const id of ["plus", "free", "signed-out", "unchecked"]) {
    await mkdir(join(home, id));
    await opened.register(
      createInstance({ id, provider: "codex", label: id, homeDir: join(home, id) }),
    );
    // Like the CLI's own login at startup: nothing has said yet whether it is signed in.
    if (id === "unchecked") continue;
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
  unchecked: {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: (now + 2 * hour) / 1000 },
        secondary: {
          usedPercent: 9,
          windowDurationMins: 10080,
          resetsAt: (now + 90 * hour) / 1000,
        },
      },
    },
  },
};

test("refreshing limits records every Codex account's windows and banked resets, sign-in unchecked or not", async () => {
  const { registry: accounts, home } = await registry();
  const asked: string[] = [];
  const read: ReadCliUsage = async ({ env }) => {
    const id = env["CODEX_HOME"]?.split("/").at(-1) ?? "";
    asked.push(id);
    const result = reads[id];
    if (!result) throw new Error("not signed in");
    return result;
  };
  await refreshCliLimits({
    provider: "codex",
    registry: accounts,
    env: {},
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    // An installed CLI; the read itself stands in for it.
    discovery: { overrides: { codex: process.execPath } },
    read,
  });

  expect(asked.toSorted()).toEqual(["free", "plus", "unchecked"]);
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
  const unchecked = accounts.get("unchecked")?.quota;
  expect(Object.values(unchecked?.windows ?? {}).map((window) => window.usedPercent)).toEqual([
    40, 9,
  ]);
});

test("usage windows and resets are read per account from the Codex app-server", async () => {
  const { registry: accounts, home } = await registry();
  // Offline Codex app-server: answers `account/rateLimits/read` from each account's own home.
  const executable = join(home, "codex");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url).href)};\n`,
    { mode: 0o700 },
  );
  for (const id of ["plus", "free"])
    await writeFile(join(home, id, "usage.json"), JSON.stringify(reads[id]));
  await refreshCliLimits({
    provider: "codex",
    registry: accounts,
    env: { PATH: process.env["PATH"] ?? "" },
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    discovery: { overrides: { codex: executable } },
  });
  const windows = (id: string) =>
    Object.values(accounts.get(id)?.quota.windows ?? {}).map((window) => [
      window.windowDurationMins,
      window.usedPercent,
      window.resetsAt,
    ]);
  expect(windows("plus")).toEqual([
    [300, 0, now + 5 * hour],
    [10080, 0, now + 150 * hour],
  ]);
  expect(windows("free")).toEqual([[43200, 2, now + 700 * hour]]);
  expect(accounts.get("plus")?.quota.resetCredits?.available).toBe(3);
  // The signed-out account was never asked and has no windows of its own.
  expect(windows("signed-out")).toEqual([]);
});

test("one account whose limits can't be read leaves the others recorded", async () => {
  const { registry: accounts, home } = await registry();
  const failed: string[] = [];
  await refreshCliLimits({
    provider: "codex",
    registry: accounts,
    env: {},
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    discovery: { overrides: { codex: process.execPath } },
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

test("an account whose CLI isn't installed is skipped quietly", async () => {
  const { registry: accounts, home } = await registry();
  const asked: string[] = [];
  const failed: string[] = [];
  await refreshCliLimits({
    provider: "codex",
    registry: accounts,
    env: { PATH: home },
    cwd: home,
    now: () => now,
    signal: new AbortController().signal,
    read: async ({ env }) => {
      asked.push(env["CODEX_HOME"] ?? "");
      return reads["plus"];
    },
    onError: (instance) => failed.push(instance),
  });
  expect(asked).toEqual([]);
  expect(failed).toEqual([]);
  expect(accounts.get("plus")?.quota.windows).toEqual({});
});
