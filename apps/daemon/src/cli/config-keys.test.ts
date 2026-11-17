import { SettingsKey } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import { unsettable } from "./config-catalog.ts";
import {
  configKeys,
  formatConfigValue,
  parseConfigValue,
  resolveConfigKey,
} from "./config-keys.ts";

const noFiles = async (path: string): Promise<string> => {
  throw new Error(`no file ${path}`);
};
const files =
  (contents: Record<string, string>) =>
  async (path: string): Promise<string> => {
    const text = contents[path];
    if (text === undefined) throw new Error(`no file ${path}`);
    return text;
  };

const parse = (name: string, raw: string, read = noFiles) =>
  parseConfigValue(resolveConfigKey(name), name, raw, read);

test("ace config covers every settings key the app has, or says why it can't set one", () => {
  const listed = new Set(configKeys.map((entry) => entry.key));
  const missing = SettingsKey.options.filter((key) => !listed.has(key) && !unsettable[key]);
  expect(missing).toEqual([]);
  for (const entry of configKeys) expect(entry.summary.length).toBeGreaterThan(10);
});

describe("the first CLI's three short names stay aliases of their settings keys", () => {
  test.each([
    ["retention-days", "storage.retentionDays"],
    ["log-cap", "logs.maxBytes"],
    ["preparation-timeout", "worktree.preparationTimeoutMs"],
  ])("%s is %s", (alias, key) => {
    expect(resolveConfigKey(alias).key).toBe(key);
    expect(resolveConfigKey(key).key).toBe(key);
  });
});

describe("a value from the command line becomes the setting's value", () => {
  test.each<[string, string, unknown]>([
    ["threads.useWorktree", "off", false],
    ["threads.useWorktree", "ON", true],
    ["beta.marketplace", "yes", true],
    ["providers.default", "claude", "claude"],
    ["threads.sortBy", "created", "created"],
    ["providers.coder.provider", "none", null],
    ["providers.coder.provider", "codex", "codex"],
    ["agents.maxRunningChildren", "8", 8],
    ["agents.maxRunningChildren", "none", null],
    ["retention-days", "60", 60],
    ["log-cap", "512m", 512 * 1024 ** 2],
    ["preparation-timeout", "600000", 600_000],
    ["host.displayName", "Studio Mac", "Studio Mac"],
    ["browser.downloadDir", "", ""],
    ["computer.blockedApps", "1Password, Keychain Access", ["1Password", "Keychain Access"]],
    ["projects.roots", "", []],
    ["remote.mcpPublicUrl", "https://ace.example.com", "https://ace.example.com"],
    ["remote.mcpPublicUrl", "none", null],
  ])("%s %s", async (name, raw, value) => {
    expect(await parse(name, raw)).toEqual(value);
  });

  test("a structured setting reads JSON from @FILE", async () => {
    const read = files({ "keep.json": '{"provider":"claude","model":"haiku"}' });
    expect(await parse("generation.model", "@keep.json", read)).toEqual({
      provider: "claude",
      model: "haiku",
    });
  });
});

describe("a value the setting doesn't take is a usage error saying what it takes", () => {
  test.each<[string, string, string]>([
    ["threads.useWorktree", "maybe", "threads.useWorktree must be on or off."],
    ["providers.default", "gpt", "providers.default must be claude, codex"],
    ["threads.autoSettleAfter", "3d", "must be 1d, 2d, 1w or never."],
    ["agents.maxRunningChildren", "65", "a whole number from 1 to 64, or none"],
    ["agents.maxRunningChildren", "two", "a whole number from 1 to 64"],
    ["retention-days", "0", "retention-days must be a whole number of days from 1 to 3650."],
    ["log-cap", "1k", "a size from 1m to 64g"],
    ["preparation-timeout", "5", "milliseconds from 60000 to 3600000"],
    ["providers.codex.toolSource", "relative/path", "providers.codex.toolSource must be text"],
    ["remote.mcpPublicUrl", "http://ace.example.com", "must be text, or none"],
    ["generation.model", "haiku", "@FILE, a JSON file, or none"],
  ])("%s %s", async (name, raw, words) => {
    const failure = parse(name, raw);
    await expect(failure).rejects.toMatchObject({
      outcome: "usage",
      detail: { code: "bad_argument", argument: "VALUE" },
    });
    await expect(failure).rejects.toThrow(words);
  });

  test("a @FILE that can't be read or isn't JSON says which", async () => {
    await expect(parse("storage.retention", "@missing.json")).rejects.toThrow(
      "Couldn't read missing.json.",
    );
    const read = files({ "bad.json": "{logs:" });
    await expect(parse("storage.retention", "@bad.json", read)).rejects.toThrow(
      "bad.json isn't JSON.",
    );
  });
});

test("an unknown name is a usage error with the nearest key; a read-only one is refused with why", () => {
  expect(() => resolveConfigKey("threads.useWorktre")).toThrow(
    expect.objectContaining({
      outcome: "usage",
      detail: expect.objectContaining({
        hint: "Did you mean threads.useWorktree? See every setting with ace config list.",
      }),
    }),
  );
  expect(() => resolveConfigKey("browser.downloadDefault")).toThrow(
    expect.objectContaining({
      outcome: "refused",
      message: expect.stringContaining("reported by the daemon"),
    }),
  );
});

test.each<[string, unknown, string]>([
  ["threads.useWorktree", true, "on"],
  ["providers.coder.provider", null, "none"],
  ["storage.retentionDays", 120, "120 days"],
  ["logs.maxBytes", 1024 ** 3, "1 GiB"],
  ["worktree.preparationTimeoutMs", 600_000, "10 minutes"],
  ["computer.blockedApps", [], "none"],
  ["browser.downloadDir", "", "(empty)"],
  [
    "generation.model",
    { provider: "claude", model: "haiku" },
    '{"provider":"claude","model":"haiku"}',
  ],
])("%s reads as %s", (key, value, words) => {
  expect(formatConfigValue(resolveConfigKey(key).key, value)).toBe(words);
});
