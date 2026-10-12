import { AgentCatalogPage, type AgentCatalogInput, type McpAttribution } from "@ace/protocol";
import { withinJsonBudget } from "@ace/mcp-server";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { callerThread } from "./authorization.ts";
import type { z } from "zod";
import type { DelegationDependencies } from "./delegations.ts";

/** Read the same retained catalog as models.list; never launch a discovery session. */
export function readAgentCatalog(
  deps: DelegationDependencies,
  caller: McpAttribution,
  input: z.infer<typeof AgentCatalogInput>,
) {
  const parent = callerThread(deps.store, caller);
  const { instanceOffset, permissionOffset, ...filter } = input;
  const page = deps.models.list(filter);
  const ceiling = { provider: parent.provider, mode: deps.engine.permissionMode(parent.id) };
  const allows = (status: import("@ace/protocol").ModelInstanceStatus, mode?: string) => {
    try {
      deps.engine.childPermissionMode(parent.id, status.provider, mode, {
        ...status,
        accountId: status.instanceId ?? status.instance,
      });
      return true;
    } catch {
      return false;
    }
  };
  const instances = page.instances.slice(instanceOffset, instanceOffset + 2).map((status) => {
    const installed = deps.engine.providerAvailability(status.provider);
    const capabilities = installed.installed
      ? deps.engine.capabilities(status.provider)
      : undefined;
    const account = deps.accounts?.get(status.instanceId ?? status.instance);
    const modes =
      status.permissionModes ??
      capabilities?.permissionModes ??
      nativePermissionModes(status.provider);
    const selected = modes
      .slice(permissionOffset, permissionOffset + 8)
      .map((mode) => Object.assign({}, mode, { description: mode.description.slice(0, 256) }));
    return Object.assign({}, status, {
      sources: undefined,
      permissionModes: selected,
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
      allowedPermissionModes: selected.filter((mode) => allows(status, mode.id)),
      allowedDefault: allows(status),
      ...(permissionOffset + selected.length < modes.length
        ? { nextPermissionOffset: permissionOffset + selected.length }
        : {}),
    });
  });
  const models = page.models.map(({ raw: _raw, ...model }) => model);
  // Reserve envelope space, including worst-case JSON string escaping.
  while (models.length > 1 && Buffer.byteLength(JSON.stringify({ instances, models })) > 180 * 1024)
    models.pop();
  const nextOffset =
    models.length < page.models.length ? input.offset + models.length : page.nextOffset;
  const result = AgentCatalogPage.parse({
    models,
    instances,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(instanceOffset + instances.length < page.instances.length
      ? { nextInstanceOffset: instanceOffset + instances.length }
      : {}),
    caller: { threadId: parent.id, permissionMode: ceiling.mode },
  });
  if (
    !withinJsonBudget(result, 240 * 1024) ||
    Buffer.byteLength(JSON.stringify(result)) > 240 * 1024
  )
    throw new Error("Catalog page exceeds budget");
  return result;
}
