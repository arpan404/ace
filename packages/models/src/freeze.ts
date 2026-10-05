import type { CatalogModel } from "@ace/protocol";

/** Shared cached rows cannot be changed by a picker or an embedded caller. */
export function freezeCatalogModel(model: CatalogModel): CatalogModel {
  for (const tier of model.serviceTiers) {
    Object.freeze(tier.parameters);
    Object.freeze(tier);
  }
  Object.freeze(model.serviceTiers);
  Object.freeze(model.reasoningEfforts);
  Object.freeze(model.inputModalities);
  Object.freeze(model.raw);
  return Object.freeze(model);
}
