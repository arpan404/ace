import { expect, test } from "vitest";
import { railGroups, type PickerEntry } from "./picker-entries.ts";

const entry = (patch: Partial<PickerEntry> & Pick<PickerEntry, "id" | "name">): PickerEntry =>
  patch;

test("a provider's accounts share one rail tab, while each ACP agent keeps its own", () => {
  const groups = railGroups([
    entry({ id: "favorites", name: "Favorites" }),
    entry({ id: "claude:a", provider: "claude", instance: "a", name: "Claude Code · Personal" }),
    entry({ id: "claude:b", provider: "claude", instance: "b", name: "Claude Code · Work" }),
    entry({
      id: "acp:g",
      provider: "acp",
      instance: "g",
      acpAgentId: "official:gemini",
      name: "Gemini",
    }),
    entry({
      id: "acp:q",
      provider: "acp",
      instance: "q",
      acpAgentId: "official:qwen",
      name: "Qwen Code",
    }),
  ]);
  expect(groups.map((group) => [group.name, group.accounts.length])).toEqual([
    ["Favorites", 1],
    ["Claude Code", 2],
    ["Gemini", 1],
    ["Qwen Code", 1],
  ]);
});

test("a provider stays usable while any of its accounts can be picked from", () => {
  const [group] = railGroups([
    entry({ id: "codex:a", provider: "codex", name: "Codex · Team", reason: "Limit reached" }),
    entry({ id: "codex:b", provider: "codex", name: "Codex · Personal" }),
  ]);
  expect(group?.reason).toBeUndefined();
});
