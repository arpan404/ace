import {
  ProviderKind,
  type CatalogModel,
  type ModelFilter,
  type ModelListOptions,
  type ModelListResult,
} from "@ace/protocol";
import { isDefaultSelection, resolveModelName } from "@ace/models";
import { ambiguousModel as ambiguous, modelElsewhere } from "./models.ts";

/** What an agent may leave out of a selection: the provider and ACP agent identity. */
export interface OpenSelection {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  acpAgentId?: string | undefined;
  installationId?: string | undefined;
  instanceId?: string | undefined;
  /** An account id: its own catalog is the only one a loose name is matched against. */
  accountId?: string | undefined;
  /** Another machine resolves the model against its own catalog. */
  machine?: string | undefined;
}
type ListModels = (options: ModelListOptions) => ModelListResult;

const named = (model: CatalogModel, name: string) =>
  model.id === name || model.nativeModelId === name || (model.aliases ?? []).includes(name);

/**
 * The catalog rows one account serves. ACP catalog keys are opaque, so an ACP account is found
 * by its source-qualified `instanceId`; every other account by its catalog instance.
 */
export function accountScope(provider: ProviderKind, account?: string): ModelFilter {
  if (!account) return { provider };
  return provider === "acp" ? { provider, instanceId: account } : { provider, instance: account };
}

/** Every catalog model of one provider, on every account (or only `account`), across all pages. */
function catalogue(list: ListModels, provider: ProviderKind, account?: string): CatalogModel[] {
  return everyPage(list, accountScope(provider, account));
}

/** Every row a filter lists, page by page until the catalog ends; never a fixed page cap. */
export function everyPage(list: ListModels, filter: ModelFilter): CatalogModel[] {
  const found: CatalogModel[] = [];
  let offset = 0;
  for (;;) {
    const result: ModelListResult = list({ ...filter, offset, limit: 100 });
    found.push(...result.models);
    // A page that does not move forward ends the read rather than looping.
    if (result.nextOffset === undefined || result.nextOffset <= offset) return found;
    offset = result.nextOffset;
  }
}

/** Every catalog model of one provider with this id, alias or native id, across pages. */
function matches(
  list: ListModels,
  provider: ProviderKind,
  name: string,
  instance?: string,
): CatalogModel[] {
  return catalogue(list, provider, instance).filter((model) => named(model, name));
}

/** Models a child can run: hidden and deprecated ones are refused at launch anyway. */
function runnable(
  list: ListModels,
  providers: readonly ProviderKind[],
  instance?: string,
): CatalogModel[] {
  return providers.flatMap((provider) =>
    catalogue(list, provider, instance).filter((model) => !model.hidden && !model.deprecated),
  );
}

/**
 * The catalog model a loosely written name means ("opus 5.5", "muse spark", "gpt 6.1 sol"),
 * when no catalog id or alias equals it. With an account, only that account's models count, so
 * a model another account serves is never chosen for it. Otherwise it searches the named
 * provider (all its accounts), else the caller's, else every provider. Undefined leaves the name
 * as given, for the launch path's own refusal.
 */
function nearestModel(
  selection: OpenSelection,
  callerProvider: ProviderKind,
  list: ListModels,
): CatalogModel | undefined {
  const name = selection.model;
  if (!name || isDefaultSelection(name) || selection.machine) return undefined;
  const home = selection.provider ?? callerProvider;
  const account = selection.accountId;
  if (matches(list, home, name, account).length) return undefined;
  if (account) {
    const near = resolveModelName(runnable(list, [home], account), name);
    if (near.kind === "ambiguous") throw ambiguous(name, near.options);
    return near.kind === "match" ? near.model : undefined;
  }
  const others = ProviderKind.options.filter((kind) => kind !== home);
  if (!selection.provider) {
    const exact = others.filter((kind) => matches(list, kind, name).length > 0);
    if (exact.length === 1) return undefined;
    if (exact.length > 1)
      throw ambiguous(
        name,
        exact.flatMap((kind) => matches(list, kind, name).slice(0, 1)),
      );
  }
  const near = resolveModelName(runnable(list, [home]), name);
  if (near.kind === "match") return near.model;
  if (near.kind === "ambiguous") throw ambiguous(name, near.options);
  const elsewhere = resolveModelName(runnable(list, others), name);
  if (!selection.provider) {
    if (elsewhere.kind === "match") return elsewhere.model;
    if (elsewhere.kind === "ambiguous") throw ambiguous(name, elsewhere.options);
    return undefined;
  }
  if (elsewhere.kind === "none") return undefined;
  const options = elsewhere.kind === "match" ? [elsewhere.model] : elsewhere.options;
  throw modelElsewhere(home, name, options);
}

/** Whether the catalog already has `model` by id or alias where the selection will look. */
export function knownModel(selection: OpenSelection, list: ListModels): boolean {
  const model = selection.model;
  if (!model || isDefaultSelection(model)) return true;
  const providers = selection.provider ? [selection.provider] : ProviderKind.options;
  return providers.some(
    (provider) => matches(list, provider, model, selection.accountId).length > 0,
  );
}

/**
 * Fill what the agent left out, from the model it named. A loosely written name becomes the
 * catalog id it means. The provider defaults to the caller's own, unless only another provider's
 * catalog has the model. An ACP model also names the agent, installation and instance that serve
 * it, so an agent never passes those ids itself.
 */
export function resolveSelection<T extends OpenSelection>(
  given: T,
  callerProvider: ProviderKind,
  list: ListModels,
): T & { provider: ProviderKind } {
  const nearest = nearestModel(given, callerProvider, list);
  const selection: T = nearest
    ? { ...given, provider: nearest.provider, model: nearest.id }
    : given;
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
  // The ACP agent and installation come from the named account's own rows when there is one.
  const served = matches(list, "acp", model, selection.accountId)[0];
  if (!served?.acpAgentId) return { ...selection, provider };
  return {
    ...selection,
    provider,
    acpAgentId: served.acpAgentId,
    ...(served.installationId ? { installationId: served.installationId } : {}),
    ...(served.instanceId ? { instanceId: served.instanceId } : {}),
  };
}
