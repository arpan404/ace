import { expect, test } from "vitest";
import { deckProviderChoices } from "./deck-start.ts";
import type { AccountOption, ModelOption } from "./models.ts";

const model = (patch: Partial<ModelOption>): ModelOption => ({
  key: "codex:m",
  id: "m",
  label: "M",
  provider: "codex",
  isDefault: false,
  fromCatalog: true,
  efforts: [],
  defaultEffort: undefined,
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

test("without signed-in accounts or a catalog, a deck runs on the CLI's own login and model", () => {
  const choices = deckProviderChoices(
    [
      model({ id: "claude:default", provider: "claude", fromCatalog: false }),
      model({ id: "cursor:default", provider: "cursor", fromCatalog: false }),
      model({ id: "acp-model", provider: "acp" }),
    ],
    [],
  );
  // Cursor has no model a deck could name, and ACP agents aren't conductor lanes.
  expect(choices.map((choice) => [choice.provider, choice.model, choice.accounts])).toEqual([
    ["claude", "claude-sonnet-4-6", ["local.claude"]],
  ]);
  expect(choices[0]?.accountLabel).toBe("default login");
});
