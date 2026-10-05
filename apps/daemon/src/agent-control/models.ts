import {
  isDefaultSelection,
  matchesModel,
  selectionModelFilter,
  type ModelCatalogApi,
} from "@ace/models";
import { AcpIdentity, type DelegationRequest, type Thread } from "@ace/protocol";

/** Only catalog identities from the selected provider/account reach provider launch. */
export function delegationModel(
  catalog: ModelCatalogApi,
  request: DelegationRequest,
  parent: Thread,
  instance?: string,
  configured?: string,
): string {
  const identity = request.provider === "acp" ? AcpIdentity.parse(request) : undefined;
  const filter = selectionModelFilter(request.provider, instance, identity);
  if (!filter) throw new Error("Cannot delegate without a source-qualified model identity");
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
    throw new Error(
      `Cannot delegate to ${request.provider}${instance ? ` account ${instance}` : ""}: requested model ${request.model ?? "(default)"} is unavailable and no valid configured default exists. Refresh the target account's model catalog or choose an available model.`,
    );
  return chosen.nativeModelId;
}
