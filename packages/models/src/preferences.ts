import type {
  CatalogModel,
  ProviderConfiguration,
  ProviderConfigurations,
  ProviderKind,
} from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";
import { freezeCatalogModel } from "./freeze.ts";

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
export function indexModelPreferences(config: ProviderConfiguration) {
  return {
    enabled: config.enabled !== false,
    hideDeprecated: config.hideDeprecated !== false,
    showOnlyFavourites: config.showOnlyFavourites === true,
    hiddenModels: new Set(config.hiddenModels),
    shownModels: new Set(config.shownModels),
    hiddenGroups: new Set(config.hiddenGroups),
    shownGroups: new Set(config.shownGroups),
    favourites: new Set(config.favourites),
  };
}
export function modelVisibility(model: CatalogModel, config: ProviderConfiguration): CatalogModel {
  return indexedVisibility(model, indexModelPreferences(config));
}
function indexedVisibility(
  model: CatalogModel,
  config: ReturnType<typeof indexModelPreferences>,
): CatalogModel {
  const group = model.nativeProviderId;
  const favourite = config.favourites.has(model.id);
  const explicitShow = config.shownModels.has(model.id);
  const groupHidden = group && config.hiddenGroups.has(group) && !config.shownGroups.has(group);
  const reason = !config.enabled
    ? "provider_disabled"
    : groupHidden
      ? "group_hidden"
      : config.hiddenModels.has(model.id)
        ? "model_hidden"
        : explicitShow
          ? undefined
          : (model.deprecated || model.legacy) && config.hideDeprecated
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
    providerEnabled: config.enabled,
    ...(visibilityReason ? { visibilityReason } : {}),
  };
}
/** Custom ids are explicit user opt-ins, even without discovered connectivity.
 * They retain their exact spelling and never overwrite reported metadata. */
export function configuredModels(
  models: readonly CatalogModel[],
  provider: ProviderKind,
  instance: string,
  config: ProviderConfiguration,
): CatalogModel[] {
  return Array.from(createModelView(models, provider, instance, config));
}

/** A bounded revision-local view; paging decorates only the requested rows. */
export function createModelView(
  models: readonly CatalogModel[],
  provider: ProviderKind,
  instance: string,
  config: ProviderConfiguration,
) {
  const index = indexModelPreferences(config);
  const found = config.customModels?.length
    ? new Set(models.map((model) => model.id))
    : new Set<string>();
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
  const decorated = new Map<number, CatalogModel>();
  const at = (position: number): CatalogModel | undefined => {
    const previous = decorated.get(position);
    if (previous) return previous;
    const row = position < models.length ? models[position] : custom[position - models.length];
    if (!row) return undefined;
    const value = freezeCatalogModel(indexedVisibility(row, index));
    decorated.set(position, value);
    return value;
  };
  return {
    length: models.length + custom.length,
    at,
    *[Symbol.iterator]() {
      for (let position = 0; position < models.length + custom.length; position++) {
        const row = at(position);
        if (row) yield row;
      }
    },
  };
}
