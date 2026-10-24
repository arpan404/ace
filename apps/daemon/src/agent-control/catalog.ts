import {
  AgentCatalogPage,
  type CatalogModel,
  type ModelFilter,
  type ModelListResult,
  type AccessMode,
  type AgentCatalogInput,
  type McpAttribution,
} from "@ace/protocol";
import { withinJsonBudget } from "@ace/mcp-server";
import { searchModels } from "@ace/models";
import { callerThread } from "./authorization.ts";
import type { z } from "zod";
import type { DelegationDependencies } from "./delegations.ts";

/** The nearest runnable models to a name, across every page and account, nearest first. */
function searched(deps: DelegationDependencies, filter: ModelFilter, query: string, limit: number) {
  const rows: CatalogModel[] = [];
  let offset: number | undefined = 0;
  for (let page = 0; offset !== undefined && page < 50; page++) {
    const result: ModelListResult = deps.models.list({ ...filter, offset, limit: 100 });
    rows.push(...result.models.filter((model) => !model.hidden && !model.deprecated));
    offset = result.nextOffset;
  }
  return searchModels(rows, query).slice(0, limit);
}

/**
 * Read the same retained catalog as models.list; never launch a discovery session. Every
 * account comes back on every page, so an agent sees all it can delegate to in one read.
 */
export function readAgentCatalog(
  deps: DelegationDependencies,
  caller: McpAttribution,
  input: z.infer<typeof AgentCatalogInput>,
) {
  const parent = callerThread(deps.store, caller);
  const { query, ...filter } = input;
  const page = deps.models.list(filter);
  const allows = (status: import("@ace/protocol").ModelInstanceStatus, mode: AccessMode) => {
    try {
      deps.engine.childAccess(parent.id, status.provider, mode, {
        ...status,
        accountId: status.instanceId ?? status.instance,
      });
      return true;
    } catch {
      return false;
    }
  };
  const instances = page.instances.map((status) => {
    const installed = deps.engine.providerAvailability(status.provider);
    const capabilities = installed.installed
      ? deps.engine.capabilities(status.provider)
      : undefined;
    const account = deps.accounts?.get(status.instanceId ?? status.instance);
    const offers = status.accessModes ?? capabilities?.accessModes ?? [];
    return Object.assign({}, status, {
      sources: undefined,
      permissionModes: undefined,
      accessModes: offers,
      installed: installed.installed,
      auth: account?.quota.auth ?? installed.auth,
      enabled:
        deps.providerEnabled?.(status.provider, status.instanceId ?? status.instance) !== false,
      ...(account
        ? {
            accountLabel: account.instance.label,
            availability: deps.accounts?.summary(
              status.instanceId ?? status.instance,
              deps.clock.now(),
            )?.availability,
          }
        : {}),
      launchOptions: capabilities?.launchOptions ?? [],
      allowedAccessModes: offers.map((offer) => offer.mode).filter((mode) => allows(status, mode)),
    });
  });
  const rows = query ? searched(deps, filter, query, input.limit) : page.models;
  const models = rows.map(({ raw: _raw, ...model }) => model);
  // Reserve envelope space, including worst-case JSON string escaping.
  while (models.length > 1 && Buffer.byteLength(JSON.stringify({ instances, models })) > 180 * 1024)
    models.pop();
  const nextOffset = query
    ? undefined
    : models.length < page.models.length
      ? input.offset + models.length
      : page.nextOffset;
  const result = AgentCatalogPage.parse({
    models,
    instances,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    caller: { threadId: parent.id, access: deps.engine.access(parent.id) },
  });
  if (
    !withinJsonBudget(result, 240 * 1024) ||
    Buffer.byteLength(JSON.stringify(result)) > 240 * 1024
  )
    throw new Error("Catalog page exceeds budget");
  return result;
}
