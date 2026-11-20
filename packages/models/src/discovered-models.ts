import type { CatalogModel, ModelSourceStatus, NativePermissionMode } from "@ace/protocol";

/** Preserve the array discovery API while carrying bounded connection diagnostics. */
export function discoveredModels(models: CatalogModel[], sources: readonly ModelSourceStatus[]) {
  const result = Object.assign(models, { sources });
  Object.defineProperty(result, "sources", { enumerable: false });
  return result;
}

/** Carry the session modes a probe saw, so access offers exist before any thread opens. */
export function withPermissionModes(
  models: CatalogModel[],
  permissionModes: readonly NativePermissionMode[],
) {
  if (!permissionModes.length) return models;
  const result = Object.assign(models, { permissionModes });
  Object.defineProperty(result, "permissionModes", { enumerable: false });
  return result;
}
