import type { ModelCatalogApi } from "@ace/models";
import { modelsAvailableWithoutAuth } from "@ace/models/availability";

/** Cached reads only; a credential failure on one upstream cannot block free/local models. */
export function hasUnauthenticatedOpenCodeModels(catalog: Pick<ModelCatalogApi, "list">): boolean {
  let offset = 0;
  // At most 64 instances with 512 rows each, in 100-row pages.
  for (let page = 0; page < 328; page++) {
    const result = catalog.list({ provider: "opencode", offset, limit: 100 });
    if (modelsAvailableWithoutAuth(result.models, result.instances)) return true;
    if (result.nextOffset === undefined) return false;
    offset = result.nextOffset;
  }
  return false;
}
