import type { CatalogModel } from "@ace/protocol";

/**
 * A live ACP session reports option sets only for the model it runs. Its catalog write keeps
 * what an earlier probe or session learned for every other model, so switching models in one
 * thread doesn't erase the thinking levels of the rest.
 */
export function keepLearnedOptions(
  models: CatalogModel[],
  previous: readonly CatalogModel[] | undefined,
): CatalogModel[] {
  if (!previous?.length) return models;
  const known = new Map(previous.map((model) => [model.id, model]));
  return models.map((model) => {
    const before = known.get(model.id);
    if (model.isDefault || model.efforts.length || !before?.efforts.length) return model;
    return {
      ...model,
      efforts: before.efforts,
      ...(before.defaultEffort !== undefined ? { defaultEffort: before.defaultEffort } : {}),
      ...(before.raw ? { raw: before.raw } : {}),
    };
  });
}
