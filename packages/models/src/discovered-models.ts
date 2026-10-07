import type { CatalogModel, ModelSourceStatus } from "@ace/protocol";

/** Preserve the array discovery API while carrying bounded connection diagnostics. */
export function discoveredModels(models: CatalogModel[], sources: readonly ModelSourceStatus[]) {
  const result = Object.assign(models, { sources });
  Object.defineProperty(result, "sources", { enumerable: false });
  return result;
}
