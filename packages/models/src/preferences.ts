import type {
  CatalogModel,
  ProviderConfiguration,
  ProviderConfigurations,
  ProviderKind,
} from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";
import { cleanCatalog, defaultModel } from "./catalog-cleanup.ts";
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
    hideLegacy: config.hideDeprecated === true,
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
  const ids = [model.id, ...(model.aliases ?? [])];
  const favourite = ids.some((id) => config.favourites.has(id));
  const explicitShow = ids.some((id) => config.shownModels.has(id));
  const groupHidden = group && config.hiddenGroups.has(group) && !config.shownGroups.has(group);
  const reason = !config.enabled
    ? "provider_disabled"
    : groupHidden
      ? "group_hidden"
      : ids.some((id) => config.hiddenModels.has(id))
        ? "model_hidden"
        : explicitShow
          ? undefined
          : ((model.deprecated && config.hideDeprecated) || (model.legacy && config.hideLegacy)) &&
              !favourite
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
  return createCleanModelView(cleanCatalog(models), provider, instance, config);
}

/** Cached discoveries have already crossed the cleanup boundary. Settings edits
 * only rebuild preference indexes and choose a default; they do not parse raw data. */
export function createCleanModelView(
  models: readonly CatalogModel[],
  provider: ProviderKind,
  instance: string,
  config: ProviderConfiguration,
  accountLabel?: string,
) {
  const index = indexModelPreferences(config);
  const found = config.customModels?.length
    ? new Set(models.flatMap((model) => [model.id, ...(model.aliases ?? [])]))
    : new Set<string>();
  const customPositions = new Map(
    (config.customModels ?? []).map((model, position) => [model.id, position]),
  );
  const custom: CatalogModel[] = cleanCatalog(
    (config.customModels ?? [])
      .filter((model) => !found.has(model.id))
      // oxlint-disable-next-line oxc/no-map-spread -- Each custom row is a fresh catalog value.
      .map((model) => {
        const name = modelDisplayName(model.id, model.displayName);
        return {
          ...model,
          provider,
          instance,
          nativeModelId: name.upstreamProvider
            ? model.id.slice(model.id.indexOf("/") + 1)
            : model.id,
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
      }),
  ).toSorted((a, b) => {
    // Settings order is explicit; numeric custom IDs are not a preference ranking.
    return (customPositions.get(a.id) ?? 0) - (customPositions.get(b.id) ?? 0);
  });
  const selection = defaultModel(
    [...models, ...custom].map((row) => indexedVisibility(row, index)),
    provider,
    config.defaultModel ?? undefined,
  );
  const decorated = new Map<number, CatalogModel>();
  const at = (position: number): CatalogModel | undefined => {
    const previous = decorated.get(position);
    if (previous) return previous;
    const row = position < models.length ? models[position] : custom[position - models.length];
    if (!row) return undefined;
    const visible = indexedVisibility(row, index);
    const { defaultSource: _source, ...rest } = visible;
    const value = freezeCatalogModel({
      ...rest,
      ...(accountLabel && rest.source?.kind === "account"
        ? { source: { ...rest.source, label: accountLabel } }
        : {}),
      isDefault: row.id === selection?.model.id,
      ...(row.id === selection?.model.id ? { defaultSource: selection.source } : {}),
    });
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
