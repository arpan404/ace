import type { ProviderKind } from "@ace/protocol";
import { expect, test } from "vitest";
import { limitDestinations } from "./limit-switch.ts";
import type { ModelChoice } from "./models.ts";

function choice(
  provider: ProviderKind,
  accountId: string,
  modelId: string,
  extra: Partial<ModelChoice> = {},
): ModelChoice {
  return {
    id: `${accountId}:${modelId}`,
    provider,
    model: modelId.toUpperCase(),
    modelId,
    aliases: [],
    account: accountId ? accountId.split("-")[1] ?? accountId : "",
    accountId,
    note: "",
    used: undefined,
    exhausted: false,
    resetsAt: undefined,
    isDefault: false,
    efforts: [],
    defaultEffort: undefined,
    key: `${provider}\u0000${modelId}`,
    isNew: false,
    legacy: false,
    speeds: [],
    defaultSpeed: "standard",
    ...extra,
  };
}

const ranOut = { provider: "codex" as const, accountId: "codex-team", key: "codex\u0000gpt-6" };

test("the limit's Switch lists accounts with room first, same provider before a handoff, most room first", () => {
  const rows = limitDestinations(
    [
      choice("codex", "codex-team", "gpt-6", { exhausted: true }),
      choice("claude", "claude-work", "opus", { used: 0.1, isDefault: true }),
      choice("codex", "codex-personal", "gpt-6", { used: 0.38 }),
      choice("claude", "claude-home", "opus", { used: 0.6 }),
      choice("codex", "codex-spare", "gpt-6", { exhausted: true }),
    ],
    ranOut,
  );
  expect(rows.map((row) => [row.name, row.model, row.left, row.handsOver])).toEqual([
    ["Codex · personal", "GPT-6", "62% left", false],
    ["Claude Code · work", "OPUS", "90% left", true],
    ["Claude Code · home", "OPUS", "40% left", true],
  ]);
});

test("each account carries on with the same model where it runs, else its default", () => {
  const rows = limitDestinations(
    [
      choice("codex", "codex-personal", "gpt-5"),
      choice("codex", "codex-personal", "gpt-6"),
      choice("claude", "claude-work", "sonnet"),
      choice("claude", "claude-work", "opus", { isDefault: true }),
    ],
    ranOut,
  );
  expect(rows.map((row) => row.action.selection)).toEqual([
    { provider: "codex", model: "gpt-6", instanceId: "codex-personal" },
    { provider: "claude", model: "opus", instanceId: "claude-work" },
  ]);
});

test("nothing is offered where the thread can't move or no account has room", () => {
  const choices = [
    choice("codex", "codex-team", "gpt-6"),
    choice("cursor", "cursor-main", "composer"),
    choice("claude", "claude-work", "opus", { exhausted: true }),
  ];
  expect(limitDestinations(choices, ranOut, (row) => row.provider !== "cursor")).toEqual([]);
});
