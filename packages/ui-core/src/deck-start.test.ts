import { expect, test } from "vitest";
import { deckProviderChoices } from "./deck-start.ts";
import type { AccountOption, ModelOption } from "./models.ts";

const model = (patch: Partial<ModelOption>): ModelOption => ({
  key: `${patch.provider ?? "codex"}:${patch.id ?? "m"}`,
  id: "m",
  account: "codex-personal",
  scope: { provider: "codex", instance: patch.account ?? "codex-personal" },
  label: "M",
  provider: "codex",
  isDefault: false,
  efforts: [],
  defaultEffort: undefined,
  isNew: false,
  legacy: false,
  fastTier: undefined,
  fastDefault: false,
  ...patch,
});
const account = (patch: Partial<AccountOption>): AccountOption => ({
  id: "codex-personal",
  provider: "codex",
  label: "Personal",
  usage: "no usage reported",
  isDefault: false,
  ...patch,
});

test("a provider runs its catalog default model on every signed-in account, the default first", () => {
  const [codex] = deckProviderChoices(
    [
      model({ id: "gpt-5.2", label: "GPT-5.2" }),
      model({ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", isDefault: true }),
    ],
    [account({ id: "codex-work", label: "Work" }), account({ isDefault: true })],
  );
  expect(codex).toEqual({
    provider: "codex",
    label: "Codex",
    model: "gpt-5.3-codex",
    modelLabel: "GPT-5.3 Codex",
    accounts: ["codex-personal", "codex-work"],
    accountLabel: "Personal, Work",
  });
});

test("each account keeps its own default: a deck names the default account's", () => {
  const [codex] = deckProviderChoices(
    [
      model({ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", isDefault: true }),
      model({ id: "gpt-5.2", label: "GPT-5.2", account: "codex-work" }),
      model({ id: "gpt-5.4", label: "GPT-5.4", account: "codex-work", isDefault: true }),
    ],
    [account({ id: "codex-work", label: "Work", isDefault: true }), account({})],
  );
  expect(codex).toMatchObject({ model: "gpt-5.4", accounts: ["codex-work", "codex-personal"] });
});

test("without signed-in accounts a deck runs on the CLI's own login, and never on a made-up model", () => {
  const choices = deckProviderChoices(
    [
      model({ id: "claude-opus-5-5", provider: "claude", account: "claude-cli-default" }),
      model({ id: "acp-model", provider: "acp" }),
    ],
    [],
  );
  // ACP agents aren't conductor lanes, and a provider whose catalog lists nothing isn't offered.
  expect(choices.map((choice) => [choice.provider, choice.model, choice.accounts])).toEqual([
    ["claude", "claude-opus-5-5", ["local.claude"]],
  ]);
  expect(choices[0]?.accountLabel).toBe("default login");
});
