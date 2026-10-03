import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { blockingReset, tightestWindow, type AccountView } from "./accounts.ts";

/** One model on one of the person's signed-in accounts, as the composer's picker lists it. */
export interface ModelChoice {
  /** The catalog row id; unique per model and account. */
  id: string;
  provider: ProviderKind;
  /** Display name, "Opus 4.1". */
  model: string;
  /** What thread.create carries as `model`. */
  modelId: string;
  /** The account label, "Personal"; empty when the provider has no accounts. */
  account: string;
  accountId: string;
  /** "62% of 5-hour window used", "Default model", or the provider's own config. */
  note: string;
  /** Share of the tightest window spent, 0..1, when the provider reports it. */
  used: number | undefined;
  /** The account can't take work until its window resets. */
  exhausted: boolean;
  resetsAt: number | undefined;
  isDefault: boolean;
}

function note(model: CatalogModel, account: AccountView | undefined): string {
  if (!account) return model.isDefault ? "Default model" : "";
  if (!account.signedIn) return "Signed out";
  const window = tightestWindow(account);
  return window ? `${window.usedPercent}% of ${window.label} window used` : "No usage reported";
}

/**
 * `models.list` joined with `accounts.list`: each visible model under the account (instance)
 * that serves it, grouped by provider in catalog order, signed-out accounts left out.
 */
export function modelChoices(
  models: readonly CatalogModel[],
  accounts: readonly AccountView[],
): ModelChoice[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.flatMap((provider) =>
    models
      .filter((model) => model.provider === provider && !model.hidden)
      .flatMap((model): ModelChoice[] => {
        const account = byId.get(model.instance);
        if (account && !account.signedIn) return [];
        const window = account && tightestWindow(account);
        const exhausted = account?.availability === "exhausted";
        return [
          {
            id: model.id,
            provider,
            model: model.displayName,
            modelId: model.nativeModelId,
            account: account?.label ?? "",
            accountId: model.instance,
            note: note(model, account),
            used: window ? window.usedPercent / 100 : undefined,
            exhausted,
            resetsAt: exhausted && account ? blockingReset(account) : undefined,
            isDefault: model.isDefault,
          },
        ];
      }),
  );
}

/** What a thread starts with until the person picks: the provider's default, else any usable. */
export function defaultModelChoice(
  choices: readonly ModelChoice[],
  provider: ProviderKind | undefined,
): ModelChoice | undefined {
  const usable = choices.filter((choice) => !choice.exhausted);
  return (
    usable.find((choice) => choice.provider === provider && choice.isDefault) ??
    usable.find((choice) => choice.provider === provider) ??
    usable.find((choice) => choice.isDefault) ??
    usable[0]
  );
}
