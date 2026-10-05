import type { ProviderKind } from "@ace/protocol";
import { selectNewThreadModel, type AccountOption, type ModelOption } from "./models.ts";
import { providerNames } from "./providers.ts";

/*
 * What New deck can offer from the daemon's catalogs (`models.list`, `accounts.list`): each
 * provider a deck can run on, the model its lanes use and the accounts it may draw on. A deck
 * names a concrete model for every role, so a provider is offered only when its catalog lists
 * one: the default account's own default, never a model made up for an empty catalog.
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
    const { model } = selectNewThreadModel({
      models,
      accounts,
      provider,
      model: undefined,
      account: undefined,
    });
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
