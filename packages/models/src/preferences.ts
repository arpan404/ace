import type {
  CatalogModel,
  ProviderConfiguration,
  ProviderConfigurations,
  ProviderKind,
} from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";

/** Account fields replace provider fields only when explicitly supplied. */
export function providerConfiguration(
  rows: ProviderConfigurations,
  provider: ProviderKind,
  instance?: string,
): ProviderConfiguration {
  const global = rows.find((row) => row.provider === provider && row.instance === undefined);
  const account =
    instance === undefined
      ? undefined
      : rows.find((row) => row.provider === provider && row.instance === instance);
  return {
    provider,
    ...global,
    ...account,
    ...(global?.enabled === false ? { enabled: false } : {}),
  };
}
export function modelVisibility(model: CatalogModel, config: ProviderConfiguration): CatalogModel {
  const group = model.nativeProviderId;
  const favourite = config.favourites?.includes(model.id) ?? false;
  const explicitShow = config.shownModels?.includes(model.id);
  const groupHidden =
    group && config.hiddenGroups?.includes(group) && !config.shownGroups?.includes(group);
  const reason =
    config.enabled === false
      ? "provider_disabled"
      : groupHidden
        ? "group_hidden"
        : config.hiddenModels?.includes(model.id)
          ? "model_hidden"
          : explicitShow
            ? undefined
            : (model.deprecated || model.legacy) && config.hideDeprecated !== false
              ? "deprecated"
              : model.hidden
                ? "provider_hidden"
                : undefined;
  const visibilityReason =
    reason ?? (config.showOnlyFavourites && !favourite ? "not_favourite" : undefined);
  return {
    ...model,
    hidden: visibilityReason !== undefined,
    favourite,
    providerEnabled: config.enabled !== false,
    ...(visibilityReason ? { visibilityReason } : {}),
  };
}
/** Custom ids retain their exact spelling and never overwrite reported metadata. */
export function configuredModels(
  models: readonly CatalogModel[],
  provider: ProviderKind,
  instance: string,
  config: ProviderConfiguration,
): CatalogModel[] {
  const found = new Set(models.map((model) => model.id));
  const custom: CatalogModel[] = (config.customModels ?? [])
    .filter((model) => !found.has(model.id))
    // oxlint-disable-next-line oxc/no-map-spread -- Each custom row is a fresh catalog value.
    .map((model) => {
      const name = modelDisplayName(model.id, model.displayName);
      return {
        ...model,
        provider,
        instance,
        nativeModelId: name.upstreamProvider ? model.id.slice(model.id.indexOf("/") + 1) : model.id,
        ...(name.upstreamProvider ? { nativeProviderId: name.upstreamProvider } : {}),
        reasoningEfforts: [],
        serviceTiers: [],
        inputModalities: [],
        isDefault: false,
        hidden: false,
        deprecated: false,
        custom: true,
        raw: { json: "{}", truncated: false },
      };
    });
  return [...models, ...custom].map((model) => modelVisibility(model, config));
}
