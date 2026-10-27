import type { CatalogModel, ModelInstanceStatus, ProviderKind } from "@ace/protocol";
import { unavailablePickerModel, unavailableSelection } from "./model-availability.ts";
import { pickerGroups, type ModelProblem, type PickerGroup } from "./model-groups.ts";
import { pickerModel, type PickerModel } from "./model-picker.ts";
import { newThreadOptions } from "./models.ts";

/*
 * One provider's models as its Settings page lists them: every model once (whichever account
 * serves it), the picker rows for its default, the groups the Manage list shows, the problems
 * its groups report said once each, and the default model as saved. Every client's provider page
 * draws from this.
 */

export interface ProviderModelLists {
  /** Each model once, hidden ones included, in catalog order. */
  unique: CatalogModel[];
  /** The visible models as picker rows, one per account that serves them. */
  models: PickerModel[];
  /** Every model (hidden ones too) grouped by where it comes from. */
  groups: PickerGroup[];
}

export function providerModelLists(
  catalog: readonly CatalogModel[],
  instances: readonly ModelInstanceStatus[],
  provider: ProviderKind,
): ProviderModelLists {
  const rows = catalog.filter((model) => model.provider === provider);
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const models = newThreadOptions(rows, [], []).models.map((option) =>
    pickerModel(option, option.label, option.account),
  );
  const listed = newThreadOptions(
    unique.map((model) => ({ ...model, hidden: false })),
    [],
    [],
  ).models.map((option) => pickerModel(option, option.label, option.account));
  return { unique, models, groups: pickerGroups(listed, instances, provider) };
}

const fixedBySignIn = new Set<ModelProblem["code"]>(["not_configured", "auth_expired"]);
/** Signing in to the provider (or its upstream) fixes this problem. */
export function isSignInProblem(problem: ModelProblem): boolean {
  return problem.actionId === "provider.sign_in" || fixedBySignIn.has(problem.code);
}

/**
 * The problems a provider's model groups report, each said once: two accounts that can't reach
 * the same service share one line. OpenCode and Pi list "no models" per service, so it is left to
 * their services list; and when the page lists the provider's accounts, a problem that signing
 * in fixes is left to the account's own row, which already offers the one action.
 */
export function providerModelProblems(
  groups: readonly PickerGroup[],
  provider: ProviderKind,
  accountsListed: boolean,
): { problem: ModelProblem; id: string }[] {
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    group.problems.flatMap((problem, index) => {
      if (problem.code === "no_models" && ["opencode", "pi"].includes(provider)) return [];
      if (accountsListed && isSignInProblem(problem)) return [];
      const key = [problem.code, problem.source ?? "", problem.message].join("\u0000");
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ problem, id: `${group.id}-${index}` }];
    }),
  );
}

export interface ProviderDefaultModel {
  /** One row per model, provider-wide: a saved model the catalog no longer lists leads. */
  choices: PickerModel[];
  /** The default as it stands: the saved one, else the provider's own. */
  current: PickerModel | undefined;
  /** The saved default is no longer listed. */
  missing: boolean;
}

/** The provider's default model: what the person saved, else what the provider marks default. */
export function providerDefaultModel(
  provider: ProviderKind,
  models: readonly PickerModel[],
  catalog: readonly CatalogModel[] | undefined,
  saved: string | null | undefined,
): ProviderDefaultModel {
  const seen = new Set<string>();
  const choices: PickerModel[] = models.flatMap((model) => {
    if (seen.has(model.key)) return [];
    seen.add(model.key);
    const account = !model.source || model.source.kind === "account";
    return [{ ...model, instance: undefined, ...(account ? { source: undefined } : {}) }];
  });
  const missing = !!saved && !!unavailableSelection(catalog, { provider, model: saved });
  if (missing && saved) choices.unshift(unavailablePickerModel({ provider, model: saved }));
  const current =
    (missing ? choices[0] : undefined) ??
    models.find((model) => model.isDefault && model.userDefault) ??
    models.find((model) => model.isDefault);
  return { choices, current, missing };
}

/** The model id a default-model row's key names (`modelKey`). */
export function modelIdOfKey(key: string): string {
  return key.slice(key.indexOf("\u0000") + 1);
}
