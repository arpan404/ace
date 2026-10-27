import {
  AgentCatalogPage,
  type CatalogModel,
  type ModelFilter,
  type AccessMode,
  type AgentCatalogInput,
  type McpAttribution,
  type AgentModelsInput,
  type ModelInstanceStatus,
  type ThreadId,
} from "@ace/protocol";
import { withinJsonBudget } from "@ace/mcp-server";
import { searchModels } from "@ace/models";
import { callerThread } from "./authorization.ts";
import { modelRoster } from "./model-roster.ts";
import { registeredAccounts } from "./account-names.ts";
import { everyPage } from "./selection-defaults.ts";
import type { z } from "zod";
import type { DelegationDependencies } from "./delegations.ts";

/**
 * The id `delegate` takes for the account behind a catalog row: an ACP login's source-qualified
 * instance id (its catalog key is an opaque digest), else the catalog instance.
 */
function accountOf(row: { instance: string; instanceId?: string | undefined }): string {
  return row.instanceId ?? row.instance;
}

/**
 * The nearest runnable models to a name, across every page and account, nearest first: one entry
 * per model, naming every account that serves it, so accounts never crowd out other models.
 */
function searched(deps: DelegationDependencies, filter: ModelFilter, query: string) {
  const rows = everyPage((options) => deps.models.list(options), filter).filter(
    (model) => !model.hidden && !model.deprecated,
  );
  const byModel = new Map<string, CatalogModel & { accounts: string[] }>();
  for (const model of searchModels(rows, query)) {
    const key = `${model.provider}\u0000${model.id}`;
    const entry = byModel.get(key);
    const account = accountOf(model);
    if (!entry) byModel.set(key, { ...model, accounts: [account] });
    else if (!entry.accounts.includes(account)) entry.accounts.push(account);
  }
  return [...byModel.values()];
}

/** Each account with its login state, labels and the access modes a child of `parentId` may take. */
function catalogAccounts(
  deps: DelegationDependencies,
  parentId: ThreadId,
  statuses: readonly ModelInstanceStatus[],
) {
  const allows = (status: ModelInstanceStatus, mode: AccessMode) => {
    try {
      deps.engine.childAccess(parentId, status.provider, mode, {
        ...status,
        accountId: status.instanceId ?? status.instance,
      });
      return true;
    } catch {
      return false;
    }
  };
  const instances = statuses.map((status) => {
    const installed = deps.engine.providerAvailability(status.provider);
    const capabilities = installed.installed
      ? deps.engine.capabilities(status.provider)
      : undefined;
    const account = deps.accounts?.get(status.instanceId ?? status.instance);
    const offers = status.accessModes ?? capabilities?.accessModes ?? [];
    return Object.assign({}, status, {
      accountId: accountOf(status),
      sources: undefined,
      permissionModes: undefined,
      accessModes: undefined,
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
  return instances;
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
  const instances = catalogAccounts(deps, parent.id, page.instances);
  const found = query ? searched(deps, filter, query) : undefined;
  const rows = found ? found.slice(input.offset, input.offset + input.limit) : page.models;
  const models = rows.map(({ raw: _raw, ...model }) =>
    "accounts" in model ? model : Object.assign(model, { accounts: [accountOf(model)] }),
  );
  // Reserve envelope space, including worst-case JSON string escaping. Accounts' discovery error
  // details give way first, then models (they page on), and an account is left out only as a
  // last resort.
  let accounts: typeof instances = instances;
  const fits = () =>
    Buffer.byteLength(JSON.stringify({ instances: accounts, models })) <= 180 * 1024;
  if (!fits()) accounts = accounts.map(({ errorDetail: _detail, ...account }) => account);
  while (models.length > 1 && !fits()) models.pop();
  let instancesOmitted = 0;
  while (accounts.length > 1 && !fits()) {
    accounts = accounts.slice(0, -1);
    instancesOmitted += 1;
  }
  const nextOffset = found
    ? input.offset + models.length < found.length
      ? input.offset + models.length
      : undefined
    : models.length < page.models.length
      ? input.offset + models.length
      : page.nextOffset;
  const result = AgentCatalogPage.parse({
    models,
    instances: accounts,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(instancesOmitted ? { instancesOmitted } : {}),
    caller: { threadId: parent.id, access: deps.engine.access(parent.id) },
  });
  if (
    !withinJsonBudget(result, 240 * 1024) ||
    Buffer.byteLength(JSON.stringify(result)) > 240 * 1024
  )
    throw new Error("Catalog page exceeds budget");
  return result;
}

/**
 * The compact roster the `models` tool shows, built from every page of every account so an
 * account whose rows sort late is never left without models.
 */
export function readModelRoster(
  deps: DelegationDependencies,
  caller: McpAttribution,
  input: AgentModelsInput,
) {
  const parent = callerThread(deps.store, caller);
  const filter = input.provider ? { provider: input.provider } : {};
  const statuses = deps.models.list({ ...filter, offset: 0, limit: 1 }).instances;
  const rows = everyPage((options) => deps.models.list(options), filter).map((model) => ({
    model,
    account: accountOf(model),
  }));
  const model = parent.execution?.model;
  return modelRoster({
    rows,
    accounts: catalogAccounts(deps, parent.id, statuses),
    caller: {
      access: deps.engine.access(parent.id),
      provider: parent.provider,
      ...(model ? { model } : {}),
    },
    query: input.query,
    named: registeredAccounts(deps.accounts),
  });
}
