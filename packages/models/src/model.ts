import type { CatalogModel } from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";
import { rawPayload } from "./raw.ts";
import type { ModelInstance } from "./types.ts";

export function base(
  instance: ModelInstance,
  id: string,
  displayName: string,
  raw: unknown,
): CatalogModel {
  return {
    id,
    displayName: modelDisplayName(
      id,
      displayName === id || displayName === id.slice(id.indexOf("/") + 1) ? undefined : displayName,
    ).displayName,
    nativeModelId: id,
    provider: instance.provider,
    instance: instance.id,
    ...(instance.acpAgentId ? { acpAgentId: instance.acpAgentId } : {}),
    ...(instance.installationId ? { installationId: instance.installationId } : {}),
    ...(instance.instanceId ? { instanceId: instance.instanceId } : {}),
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: rawPayload(raw),
  };
}
