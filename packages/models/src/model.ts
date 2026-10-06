import type { CatalogModel } from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";
import { rawPayload } from "./raw.ts";
import { catalogMetadata, legacyMetadata } from "./catalog-metadata.ts";
import type { ModelInstance } from "./types.ts";

export function base(
  instance: ModelInstance,
  id: string,
  displayName: string,
  raw: unknown,
): CatalogModel {
  const metadata = catalogMetadata(raw);
  return {
    id,
    displayName: modelDisplayName(
      id,
      displayName.toLowerCase() === id.toLowerCase() ||
        displayName.toLowerCase() === id.slice(id.indexOf("/") + 1).toLowerCase()
        ? undefined
        : displayName,
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
    legacy: legacyMetadata(raw),
    ...((metadata.resolvedModel ?? metadata.resolvedModelId)
      ? { resolvedModelId: metadata.resolvedModel ?? metadata.resolvedModelId }
      : {}),
    ...(metadata.aliases ? { aliases: metadata.aliases } : {}),
    raw: rawPayload(raw),
  };
}
