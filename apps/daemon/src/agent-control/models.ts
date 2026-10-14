import { AgentControlError } from "./failure.ts";
import {
  executionModelId,
  isDefaultSelection,
  matchesModel,
  selectionModelFilter,
  type ModelCatalogApi,
} from "@ace/models";
import { AcpIdentity, type DelegationRequest, type Thread } from "@ace/protocol";

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
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = catalog.list({ ...filter, offset, limit: 100 });
    rows.push(...page.models);
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  const available = rows.filter((row) => !row.hidden && !row.deprecated);
  const find = (id: string | undefined) => {
    if (!id || isDefaultSelection(id)) return undefined;
    const exact = available.find((row) => matchesModel(row, id));
    if (exact) return exact;
    const aliases = available.filter(
      (row) => !row.nativeProviderId && [row.nativeModelId, row.resolvedModelId].includes(id),
    );
    return aliases.length === 1 ? aliases[0] : undefined;
  };
  const chosen =
    find(request.model) ??
    find(configured) ??
    available.find((row) => row.isDefault) ??
    (parent.provider === request.provider ? find(parent.execution?.model) : undefined);
  if (!chosen)
    throw new AgentControlError(
      "model_unavailable",
      `Cannot delegate to ${request.provider}${instance ? ` account ${instance}` : ""}: requested model ${request.model ?? "(default)"} is unavailable and no valid configured default exists. Refresh the target account's model catalog or choose an available model.`,
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
