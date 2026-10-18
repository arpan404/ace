import {
  ProviderKind,
  type CatalogModel,
  type ModelListOptions,
  type ModelListResult,
} from "@ace/protocol";

/** What an agent may leave out of a selection: the provider and ACP agent identity. */
export interface OpenSelection {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  acpAgentId?: string | undefined;
  installationId?: string | undefined;
  instanceId?: string | undefined;
}
type ListModels = (options: ModelListOptions) => ModelListResult;

const named = (model: CatalogModel, name: string) =>
  model.id === name || model.nativeModelId === name || (model.aliases ?? []).includes(name);

/** Every catalog model of one provider with this id, alias or native id, across pages. */
function matches(list: ListModels, provider: ProviderKind, name: string): CatalogModel[] {
  const found: CatalogModel[] = [];
  let offset: number | undefined = 0;
  // A provider's catalog is bounded (100 per page); ten pages covers every installed account.
  for (let page = 0; offset !== undefined && page < 10; page++) {
    const result: ModelListResult = list({ provider, offset, limit: 100 });
    found.push(...result.models.filter((model) => named(model, name)));
    offset = result.nextOffset;
  }
  return found;
}

/**
 * Fill what the agent left out, from the model it named. The provider defaults to the caller's
 * own, unless only another provider's catalog has the model. An ACP model also names the agent,
 * installation and instance that serve it, so an agent never passes those ids itself.
 */
export function resolveSelection<T extends OpenSelection>(
  selection: T,
  callerProvider: ProviderKind,
  list: ListModels,
): T & { provider: ProviderKind } {
  const model = selection.model;
  let provider = selection.provider;
  if (!provider) {
    provider = callerProvider;
    if (model && !matches(list, callerProvider, model).length) {
      const elsewhere = ProviderKind.options.filter(
        (kind) => kind !== callerProvider && matches(list, kind, model).length > 0,
      );
      if (elsewhere.length === 1 && elsewhere[0]) provider = elsewhere[0];
    }
  }
  if (provider !== "acp" || !model || selection.acpAgentId) return { ...selection, provider };
  const served = matches(list, "acp", model)[0];
  if (!served?.acpAgentId) return { ...selection, provider };
  return {
    ...selection,
    provider,
    acpAgentId: served.acpAgentId,
    ...(served.installationId ? { installationId: served.installationId } : {}),
    ...(served.instanceId ? { instanceId: served.instanceId } : {}),
  };
}
