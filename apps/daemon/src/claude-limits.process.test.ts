import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { AccountService, openRegistry, type AccountRegistry } from "@ace/accounts";
import { AccountManagement } from "./account-management.ts";

/*
 * Claude's plan limits at daemon startup, with no session open: the real Agent SDK drives the
 * synthetic Claude CLI (`testing/cli.ts`), which answers `get_usage` as Claude Code 2.1.300 does
 * for a Max login. No model, no network and no installed CLI is involved.
 */

const now = Date.parse("2026-10-15T15:40:00Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** `get_usage` from a Max login, trimmed: session 32%, weekly 97%, Fable's own weekly 6%. */
const maxUsage = (sessionPercent: number) => ({
  session: { total_cost_usd: 0, total_api_duration_ms: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: sessionPercent, resets_at: "2026-10-15T16:10:00.282237+00:00" },
    seven_day: { utilization: 97, resets_at: "2026-10-17T12:00:00.282258+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [
      { display_name: "Fable", utilization: 6, resets_at: "2026-10-17T12:00:00.282459+00:00" },
    ],
    extra_usage: { is_enabled: false, utilization: null },
  },
  behaviors: null,
});

async function startDaemonAccounts(cliEnv: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-limits-"));
  const dataDir = join(root, "daemon");
  const bin = join(root, "bin");
  await Promise.all([mkdir(dataDir), mkdir(join(root, "home")), mkdir(bin)]);
  const claude = join(bin, "claude");
  const fake = new URL("../../../packages/adapter-claude/src/testing/cli.ts", import.meta.url);
  await writeFile(claude, `#!${process.execPath}\nimport ${JSON.stringify(fake.href)};\n`, {
    mode: 0o700,
  });
  // Only the synthetic Claude CLI is reachable; every other provider's CLI is absent.
  const env = {
    ...process.env,
    PATH: bin,
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: undefined,
    ...cliEnv,
  };
  const registry = await openRegistry(join(dataDir, "accounts.sqlite"));
  const logs: string[] = [];
  const management = new AccountManagement({
    registry,
    accounts: new AccountService({ registry, env, now: () => now, timeZone: "UTC" }),
    dataDir,
    env,
    now: () => now,
    id: randomUUID,
    models: () => undefined,
    discovery: { overrides: { claude } },
    limitsError: (instance, error) =>
      logs.push(`${instance}: ${error instanceof Error ? error.message : String(error)}`),
  });
  cleanups.push(async () => {
    await management.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  await management.initialize();
  return { registry, management, logs, root };
}

const claudeAccount = (registry: AccountRegistry) =>
  registry.summaries(now).find((account) => account.id === "claude-cli-default");

test("Claude usage is read at startup without an open session", async () => {
  const usageFile = join(tmpdir(), `ace-claude-usage-${randomUUID()}.json`);
  await writeFile(usageFile, JSON.stringify(maxUsage(32)));
  cleanups.push(() => rm(usageFile, { force: true }));
  const { registry } = await startDaemonAccounts({ ACE_FAKE_CLAUDE_USAGE_FILE: usageFile });
  await expect
    .poll(() => Object.keys(claudeAccount(registry)?.quota.windows ?? {}), { timeout: 20_000 })
    .toEqual(["five_hour", "seven_day", "seven_day_model:Fable"]);
  const account = claudeAccount(registry);
  expect(account?.quota.plan).toBe("max");
  expect(account?.quota.windows).toMatchObject({
    five_hour: {
      usedPercent: 32,
      resetsAt: Date.parse("2026-10-15T16:10:00.282Z"),
      windowDurationMins: 300,
    },
    seven_day: { usedPercent: 97, windowDurationMins: 10080 },
    // A model's own weekly limit is shown, but only the account's windows hold its work.
    "seven_day_model:Fable": { usedPercent: 6, limitName: "Fable", advisory: true },
  });
  expect(account?.quota.windows["five_hour"]?.advisory).toBeUndefined();
});

test("refreshing limits reads Claude again, with no session open", async () => {
  const usageFile = join(tmpdir(), `ace-claude-usage-${randomUUID()}.json`);
  await writeFile(usageFile, JSON.stringify(maxUsage(32)));
  cleanups.push(() => rm(usageFile, { force: true }));
  const { registry, management } = await startDaemonAccounts({
    ACE_FAKE_CLAUDE_USAGE_FILE: usageFile,
  });
  const session = () => claudeAccount(registry)?.quota.windows["five_hour"]?.usedPercent;
  await expect.poll(session, { timeout: 20_000 }).toBe(32);
  await writeFile(usageFile, JSON.stringify(maxUsage(54)));
  await management.refreshLimits();
  expect(session()).toBe(54);
});

test("the token never appears in logs, errors or events", async () => {
  // The CLI's failed read echoes its credential on stderr and in its error answer.
  const secret = "sk-ant-oat01-fakeTokenNeverShown9f8e7d";
  const { registry, logs } = await startDaemonAccounts({ ACE_FAKE_CLAUDE_USAGE_ERROR: secret });
  await expect
    .poll(() => logs.filter((line) => line.startsWith("claude")), { timeout: 20_000 })
    .toEqual(["claude-cli-default: Claude Code usage is unavailable"]);
  expect(claudeAccount(registry)?.quota.windows).toEqual({});
  expect(JSON.stringify(registry.summaries(now))).not.toContain(secret);
  expect(JSON.stringify(registry.list())).not.toContain(secret);
  expect(logs.join("\n")).not.toContain(secret);
});
