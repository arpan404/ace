import { AccountSummary } from "@ace/protocol/accounts";
import { accountView } from "@ace/ui-core";
import { expect, test } from "vitest";
import { pickerEntries, railGroups } from "./picker-entries.ts";

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
      availability: "logged_in",
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
  railGroups(
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
    ),
  );

test("a provider's accounts share one rail tab, while each ACP agent keeps its own, by name", () => {
  const groups = rail([
    account("claude-personal", "claude", "Personal"),
    account("claude-work", "claude", "Work"),
    account("gemini", "acp", "Google", "official:gemini"),
    account("qwen", "acp", "Alibaba", "official:qwen-code"),
  ]);
  expect(groups.map((group) => [group.name, group.accounts.map((entry) => entry.name)])).toEqual([
    ["Favorites", ["Favorites"]],
    ["Claude Code", ["Claude Code · Personal", "Claude Code · Work"]],
    ["Gemini CLI", ["Gemini CLI"]],
    ["Qwen Code", ["Qwen Code"]],
  ]);
  expect(groups.some((group) => group.name.startsWith("ACP agent"))).toBe(false);
});

test("a provider stays usable while any of its accounts can be picked from", () => {
  const codex = rail([
    account("codex-team", "codex", "Team", undefined, true),
    account("codex-personal", "codex", "Personal"),
  ]).find((group) => group.provider === "codex");
  expect(codex?.accounts.map((entry) => entry.reason)).toEqual(["Limit reached", undefined]);
  expect(codex?.reason).toBeUndefined();
});
