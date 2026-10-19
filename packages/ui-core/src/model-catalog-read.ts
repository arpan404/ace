import type { ModelServicePort } from "@ace/client";
import type { CatalogModel, ModelFilter, ModelInstanceStatus } from "@ace/protocol";
import { withoutEmptySources } from "@ace/models/availability";

/*
 * Reading the whole model catalog (`models.list`), page by page, the same way on every client:
 * the web's pickers and the native apps' New thread sheet.
 */

/** Every model row, and each account's (instance's) freshness and discovery errors. */
export interface ModelCatalog {
  models: CatalogModel[];
  instances: ModelInstanceStatus[];
}

/** Pages a large catalog in; the daemon returns at most 100 rows per `models.list`. */
const maxPages = 8;

/** One account's identity in the catalog: its provider and instance. */
export const catalogScopeKey = (row: { provider: string; instance: string }) =>
  `${row.provider}\u0000${row.instance}`;

/** Every page of `models.list` for `filter` (the whole catalog when empty). */
export async function readModelCatalog(
  client: ModelServicePort,
  filter: ModelFilter,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  const models: CatalogModel[] = [];
  const instances = new Map<string, ModelInstanceStatus>();
  let offset: number | undefined = 0;
  for (let page = 0; page < maxPages && offset !== undefined; page++) {
    const start: number = offset;
    const reply = await client.request(
      { type: "models.list", options: { ...filter, offset: start, limit: 100 } },
      signal ? { signal } : {},
    );
    if (!("models" in reply.result)) throw new Error("Couldn't load models. Try again.");
    models.push(...reply.result.models);
    for (const status of reply.result.instances) instances.set(catalogScopeKey(status), status);
    offset = reply.result.nextOffset;
  }
  const statuses = [...instances.values()];
  return { models: withoutEmptySources(models, statuses), instances: statuses };
}
