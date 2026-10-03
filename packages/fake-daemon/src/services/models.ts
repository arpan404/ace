import type { CatalogModel, ModelListResult, ModelResolution } from "@ace/protocol";

interface Filter {
  provider?: string | undefined;
  instance?: string | undefined;
}

function matching(models: readonly CatalogModel[], filter: Filter): CatalogModel[] {
  return models.filter(
    (model) =>
      (!filter.provider || model.provider === filter.provider) &&
      (!filter.instance || model.instance === filter.instance),
  );
}

/** One page of the catalog, with the offset of the next page when more remain. */
export function listModels(
  models: readonly CatalogModel[],
  options: Filter & { offset: number; limit: number },
): ModelListResult {
  const found = matching(models, options);
  const end = options.offset + options.limit;
  return {
    models: found.slice(options.offset, end),
    instances: [],
    ...(found.length > end ? { nextOffset: end } : {}),
  };
}

/** The requested model when the catalog has it, else the first match for the role's filter. */
export function resolveModel(
  models: readonly CatalogModel[],
  spec: Filter & { model?: string | undefined },
): ModelResolution {
  const model = matching(models, spec).find(
    (entry) => !spec.model || entry.nativeModelId === spec.model || entry.id === spec.model,
  );
  return model
    ? { ok: true, model, stale: false, reason: "Fake catalog" }
    : { ok: false, reason: "Model unavailable" };
}
