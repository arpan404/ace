import { AccountSummary } from "@ace/protocol/accounts";
import { accountView } from "./accounts.ts";
import { expect, test } from "vitest";
import { pickerEntries, startingTab } from "./picker-entries.ts";

const account = (
  id: string,
  provider: "claude" | "codex" | "acp",
  label: string,
  acp?: string,
  limited = false,
) =>
  accountView(
    AccountSummary.parse({
      id,
      provider,
      label,
      ...(acp ? { acpAgentId: acp, installationId: `${id}-install`, instanceId: id } : {}),
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: 1,
        windows: limited ? { daily: { usedPercent: 100, resetsAt: 500 } } : {},
        blockers: {},
        usage: {},
      },
    }),
  );

const rail = (accounts: ReturnType<typeof account>[]) =>
  pickerEntries(
    [
      { provider: "claude", reason: undefined },
      { provider: "codex", reason: undefined },
      { provider: "acp", reason: undefined },
    ],
    [],
    accounts,
    1,
    () => "Limit reached",
  );

test("each account gets its own rail tab, while each ACP agent goes by its own name", () => {
  const tabs = rail([
    account("claude-personal", "claude", "Personal"),
    account("claude-work", "claude", "Work"),
    account("gemini", "acp", "Google", "official:gemini"),
    account("qwen", "acp", "Alibaba", "official:qwen-code"),
  ]);
  expect(tabs.map((tab) => tab.name)).toEqual([
    "Favorites",
    "Claude Code · Personal",
    "Claude Code · Work",
    // A provider with no account still has its tab, to say why it has nothing to pick.
    "Codex",
    "Gemini CLI",
    "Qwen Code",
  ]);
  expect(tabs.some((tab) => tab.name.startsWith("ACP agent"))).toBe(false);
});

test("an account at its limit keeps its tab and says why, beside a usable one", () => {
  const codex = rail([
    account("codex-team", "codex", "Team", undefined, true),
    account("codex-personal", "codex", "Personal"),
  ]).filter((tab) => tab.provider === "codex");
  expect(codex.map((tab) => [tab.name, tab.reason])).toEqual([
    ["Codex · Team", "Limit reached"],
    ["Codex · Personal", undefined],
  ]);
});

const cli = (label: string) =>
  accountView(
    AccountSummary.parse({
      id: "codex-cli-default",
      provider: "codex",
      label,
      implicit: true,
      availability: "available",
      quota: { auth: "logged_in", observedAt: 1, windows: {}, blockers: {}, usage: {} },
    }),
  );

test("the CLI's own login reads as the provider until it is renamed", () => {
  const names = (login: ReturnType<typeof cli>) =>
    rail([login, account("codex-team", "codex", "Team")])
      .filter((tab) => tab.provider === "codex")
      .map((tab) => tab.name);
  expect(names(cli("Your CLI login"))).toEqual(["Codex", "Codex · Team"]);
  expect(names(cli("Home"))).toEqual(["Codex · Home", "Codex · Team"]);
});

const antigravity = (id: string, label: string, home: "default_cli" | "managed") =>
  accountView(
    AccountSummary.parse({
      id,
      provider: "acp",
      label,
      acpAgentId: "official:antigravity-acp",
      installationId: "antigravity-cli",
      instanceId: id,
      homeStrategy: home,
      isDefault: home === "default_cli",
      availability: "available",
      quota: { auth: "logged_in", observedAt: 1, windows: {}, blockers: {}, usage: {} },
    }),
  );

test("Antigravity's CLI login is Antigravity itself, and each added account gets its own named tab", () => {
  const tabs = pickerEntries(
    [{ provider: "antigravity", reason: undefined }],
    [],
    [
      antigravity("account-work", "Work", "managed"),
      antigravity("antigravity-cli-default", "Antigravity", "default_cli"),
      // Another installation of the same agent is its own ACP agent, not Antigravity's account.
      account("other", "acp", "Elsewhere", "official:antigravity-acp"),
    ],
    1,
    () => "Limit reached",
  ).filter((tab) => tab.provider === "antigravity");
  expect(tabs.map((tab) => [tab.name, tab.instance])).toEqual([
    ["Antigravity", "antigravity-cli-default"],
    ["Antigravity · Work", "account-work"],
  ]);
});

test("on a thread whose account is at its limit, the picker opens on an account with room, never the greyed one", () => {
  const tabs = rail([
    account("claude-work", "claude", "Work"),
    account("codex-team", "codex", "Team", undefined, true),
    account("codex-personal", "codex", "Personal"),
  ]);
  const at = { provider: "codex" as const, instance: "codex-team" };
  // The same provider's next account with room, even over Favorites.
  expect(startingTab(tabs, { ...at, favorites: true })?.name).toBe("Codex · Personal");
  // With no other account of its own provider, another provider's.
  const alone = rail([
    account("claude-work", "claude", "Work"),
    account("codex-team", "codex", "Team", undefined, true),
  ]);
  expect(startingTab(alone, { ...at, favorites: false })?.name).toBe("Claude Code · Work");
  // The exhausted account keeps its tab, greyed with its reset.
  expect(alone.find((tab) => tab.instance === "codex-team")?.reason).toBe("Limit reached");
  // With room on its own account, it opens there (or on Favorites when there are any).
  const fine = { provider: "codex" as const, instance: "codex-personal" };
  expect(startingTab(tabs, { ...fine, favorites: false })?.name).toBe("Codex · Personal");
  expect(startingTab(tabs, { ...fine, favorites: true })?.id).toBe("favorites");
});
