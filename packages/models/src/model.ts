import type { CatalogModel } from "@ace/protocol";
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
    displayName,
    nativeModelId: id,
    provider: instance.provider,
    instance: instance.id,
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: rawPayload(raw),
  };
}
