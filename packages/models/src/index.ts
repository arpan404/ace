export { ModelCatalog, type CatalogOptions } from "./catalog.ts";
export { openModelStorage } from "./storage.ts";
export { createModelDiscovery, type DiscoveryOptions } from "./discover.ts";
export {
  normalizeCodex,
  normalizeClaude,
  normalizeAcp,
  normalizeOpenCode,
  normalizeCursorSdk,
} from "./normalize.ts";
export { resolveModel } from "./resolve.ts";
export {
  ModelInstance,
  type InstanceInput,
  type DiscoverModels,
  type CatalogStorage,
  type CacheEntry,
  type Deadline,
  type ModelCatalogApi,
} from "./types.ts";
export type { CatalogModel, ModelRoleSpec, ModelResolution, ModelListResult } from "@ace/protocol";
export { OpenCodeParser, normalizeOpenCodeV2 } from "./open-code.ts";

export { modelDisplayName } from "./display-name.ts";
export { providerConfiguration, modelVisibility, configuredModels } from "./preferences.ts";

export { isDefaultSelection, matchesModel } from "./catalog-cleanup.ts";
