import type { ProviderKind } from "@ace/protocol";
import type { AccountOption, ModelOption } from "./models.ts";
import { providerNames } from "./providers.ts";

/*
 * What New deck can offer from the daemon's catalogs (`models.list`, `accounts.list`): each
 * provider a deck can run on, the model its lanes use and the accounts it may draw on. A deck
 * names a concrete model for every role, so a provider is offered only with one.
 */

export interface DeckProviderChoice {
  provider: ProviderKind;
  label: string;
  /** The model id the spec names for this provider's lanes. */
  model: string;
  modelLabel: string;
  /** The accounts the deck may use: the signed-in ones, else the CLI's own login. */
  accounts: readonly string[];
  /** "Personal, Work" or "default login". */
  accountLabel: string;
}

/**
 * A model each provider's lanes run when the daemon's catalog lists none for it (a daemon with
 * no model discovery). The CLI resolves the id itself.
 */
const fallbackModels: Partial<Record<ProviderKind, { id: string; label: string }>> = {
  claude: { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  codex: { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  opencode: { id: "kimi-k2", label: "Kimi K2" },
};

/** Providers the conductor drives through its own lanes; ACP agents are added per command. */
const deckProviders = new Set<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi"]);

export function deckProviderChoices(
  models: readonly ModelOption[],
  accounts: readonly AccountOption[],
): DeckProviderChoice[] {
  const providers = [...new Set(models.map((model) => model.provider))].filter((provider) =>
    deckProviders.has(provider),
  );
  return providers.flatMap((provider): DeckProviderChoice[] => {
    const listed = models.filter((model) => model.provider === provider && model.fromCatalog);
    const pick = listed.find((model) => model.isDefault) ?? listed[0];
    const model = pick ? { id: pick.id, label: pick.label } : fallbackModels[provider];
    if (!model) return [];
    const signedIn = accounts
      .filter((account) => account.provider === provider)
      .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return [
      {
        provider,
        label: providerNames[provider],
        model: model.id,
        modelLabel: model.label,
        accounts: signedIn.length ? signedIn.map((account) => account.id) : [`local.${provider}`],
        accountLabel: signedIn.length
          ? signedIn.map((account) => account.label).join(", ")
          : "default login",
      },
    ];
  });
}
