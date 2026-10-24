import { AgentControlError } from "./failure.ts";
import {
  executionModelId,
  isDefaultSelection,
  matchesModel,
  resolveModelName,
  selectionModelFilter,
  type ModelCatalogApi,
} from "@ace/models";
import {
  AcpIdentity,
  type CatalogModel,
  type DelegationRequest,
  type ModelListOptions,
  type Thread,
} from "@ace/protocol";

const listed = (models: readonly CatalogModel[]) =>
  models
    .slice(0, 8)
    .map((model) => `${model.id} (${model.provider})`)
    .join(", ");
const accounts = (models: readonly CatalogModel[]) =>
  models
    .slice(0, 8)
    .map((model) => model.instanceId ?? model.instance)
    .join(", ");

/** A loose model name that fits several models equally, refused with the ids to choose from. */
export function ambiguousModel(name: string, options: readonly CatalogModel[]): AgentControlError {
  return new AgentControlError(
    "invalid_arguments",
    "model_ambiguous",
    undefined,
    `"${name}" fits several models: ${listed(options)}. Pass one of these ids as model.`,
  );
}

/** One model several ACP logins serve as different agents, refused with the logins to choose. */
export function ambiguousLogin(model: string, rows: readonly CatalogModel[]): AgentControlError {
  return new AgentControlError(
    "invalid_arguments",
    "model_ambiguous",
    undefined,
    `${model} is served by several ACP logins: ${accounts(rows)}. Pass one as accountId.`,
  );
}

/** A provider names models elsewhere that fit, refused with where they are. */
export function modelElsewhere(
  provider: string,
  name: string,
  options: readonly CatalogModel[],
): AgentControlError {
  return new AgentControlError(
    "model_unavailable",
    "model_on_other_provider",
    undefined,
    `No ${provider} model fits "${name}". Other providers have ${listed(options)}; pass that provider, or omit provider.`,
  );
}

/** Every model one account (or filter) lists, across pages. */
function catalogRows(catalog: ModelCatalogApi, filter: ModelListOptions): CatalogModel[] {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = catalog.list({ ...filter, offset, limit: 100 });
    rows.push(...page.models);
    // A page that does not move forward ends the read rather than looping.
    if (page.nextOffset === undefined || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return rows;
}

/**
 * The catalog id a loosely written name ("opus 5.5") means on one account, for configuring or
 * forking a thread that stays on it. An exact id, alias or default stays as given, as does a name
 * nothing fits (the caller refuses it); a name that fits several models is refused.
 */
export function accountModelName(
  catalog: ModelCatalogApi,
  filter: ModelListOptions,
  name: string,
): string {
  if (isDefaultSelection(name)) return name;
  const available = catalogRows(catalog, filter).filter((row) => !row.hidden && !row.deprecated);
  if (available.some((row) => matchesModel(row, name))) return name;
  const near = resolveModelName(available, name);
  if (near.kind === "ambiguous") throw ambiguousModel(name, near.options);
  return near.kind === "match" ? near.model.id : name;
}

/** Only catalog identities from the selected provider/account reach provider launch. */
export function selectedDelegationModel(
  catalog: ModelCatalogApi,
  request: DelegationRequest,
  parent: Thread,
  instance?: string,
  configured?: string,
): import("@ace/protocol").CatalogModel {
  const identity = request.provider === "acp" ? AcpIdentity.parse(request) : undefined;
  const filter = selectionModelFilter(request.provider, instance, identity);
  if (!filter)
    throw new AgentControlError(
      "model_unavailable",
      "Cannot delegate without a source-qualified model identity",
    );
  // Page the selected account, preserving the catalog's explicit default and aliases.
  const available = catalogRows(catalog, filter).filter((row) => !row.hidden && !row.deprecated);
  const find = (id: string | undefined) => {
    if (!id || isDefaultSelection(id)) return undefined;
    const exact = available.find((row) => matchesModel(row, id));
    if (exact) return exact;
    const aliases = available.filter(
      (row) => !row.nativeProviderId && [row.nativeModelId, row.resolvedModelId].includes(id),
    );
    return aliases.length === 1 ? aliases[0] : undefined;
  };
  // A model the agent named runs as named or is refused: neither the account's default nor a
  // role model the person set for other work stands in for it. Those fill only an open choice.
  const named = request.model !== undefined && !isDefaultSelection(request.model);
  const target = `${request.provider}${instance ? ` account ${instance}` : ""}`;
  const chosen = named
    ? find(request.model)
    : (find(configured) ??
      available.find((row) => row.isDefault) ??
      (parent.provider === request.provider ? find(parent.execution?.model) : undefined));
  if (!chosen && named) {
    const role = find(configured);
    const detail = `Cannot delegate to ${target}: requested model ${request.model} is unavailable there.${role ? ` Settings → Roles names ${role.id} for ${request.provider}; pass that model to use it.` : ""} Choose a model from \`models\` or another account.`;
    throw new AgentControlError("model_unavailable", detail, undefined, detail);
  }
  if (!chosen)
    throw new AgentControlError(
      "model_unavailable",
      `Cannot delegate to ${target}: no model was named and no valid configured default exists. Refresh the target account's model catalog or choose an available model.`,
    );
  if (
    request.options?.serviceTier &&
    chosen.serviceTiers.length > 0 &&
    !chosen.serviceTiers.some((tier) => tier.id === request.options?.serviceTier)
  )
    throw new AgentControlError("not_supported", "The selected model does not offer these options");
  delegationEffort(chosen, request, parent);
  return chosen;
}

/**
 * The native effort a child runs. `inherit` (the default) keeps the parent's effort when the
 * child runs the parent's model, else leaves the model's default. An explicit effort names a
 * native id or canonical level the model lists; anything else is refused with the list, never
 * silently dropped. Effort has no ceiling.
 */
export function delegationEffort(
  model: import("@ace/protocol").CatalogModel,
  request: Pick<DelegationRequest, "effort" | "provider">,
  parent: Thread,
): string | undefined {
  const requested = request.effort;
  if (requested === undefined || requested === "inherit") {
    const inherited = parent.execution?.options?.["effort"];
    const sameModel =
      parent.provider === request.provider && parent.execution?.model === executionModelId(model);
    return sameModel && model.efforts.some((effort) => effort.id === inherited)
      ? String(inherited)
      : undefined;
  }
  const match = model.efforts.find(
    (effort) => effort.id === requested || effort.level === requested,
  );
  if (match) return match.id;
  const offered = model.efforts.map((effort) => effort.level ?? effort.id);
  throw new AgentControlError(
    "effort_unavailable",
    "effort_unavailable",
    undefined,
    offered.length
      ? `${model.id} offers ${offered.join(", ")}.`
      : `${model.id} has no effort levels; omit effort.`,
  );
}
