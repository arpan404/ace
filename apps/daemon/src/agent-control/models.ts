import type { ModelCatalogApi } from "@ace/models";
import type { DelegationRequest, Thread } from "@ace/protocol";

/** Only catalog identities from the selected provider/account reach provider launch. */
export function delegationModel(
  catalog: ModelCatalogApi,
  request: DelegationRequest,
  parent: Thread,
  instance?: string,
  configured?: string,
): string {
  const filter = {
    provider: request.provider,
    ...(instance ? { instance } : {}),
    ...(request.provider === "acp"
      ? { acpAgentId: request.acpAgentId, installationId: request.installationId }
      : {}),
  };
  // resolve(default) may choose the first row, which is not a user's default.
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = catalog.list({ ...filter, offset, limit: 100 });
    rows.push(...page.models);
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  const available = rows.filter((row) => !row.hidden && !row.deprecated);
  const find = (id: string | undefined) =>
    id
      ? available.find((row) => [row.id, row.nativeModelId, row.resolvedModelId].includes(id))
      : undefined;
  const chosen =
    find(request.model) ??
    find(configured) ??
    (parent.provider === request.provider ? find(parent.execution?.model) : undefined) ??
    available.find((row) => row.isDefault);
  if (!chosen)
    throw new Error(
      `Cannot delegate to ${request.provider}${instance ? ` account ${instance}` : ""}: requested model ${request.model ?? "(default)"} is unavailable and no valid configured default exists. Refresh the target account's model catalog or choose an available model.`,
    );
  return chosen.nativeProviderId
    ? `${chosen.nativeProviderId}/${chosen.nativeModelId}`
    : chosen.nativeModelId;
}
