import { CatalogModel, ProviderKind } from "@ace/protocol";
import { z } from "zod";

export const CachedEntry = z
  .object({
    provider: ProviderKind,
    instance: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    refreshedAt: z.number().nonnegative(),
    models: z.array(CatalogModel).max(512),
  })
  .refine(
    (entry) =>
      entry.models.every(
        (model) => model.instance === entry.instance && model.provider === entry.provider,
      ) && new Set(entry.models.map((model) => model.id)).size === entry.models.length,
  )
  .transform((entry) => {
    for (const model of entry.models) {
      for (const tier of model.serviceTiers) {
        Object.freeze(tier.parameters);
        Object.freeze(tier);
      }
      Object.freeze(model.serviceTiers);
      Object.freeze(model.reasoningEfforts);
      Object.freeze(model.inputModalities);
      Object.freeze(model.raw);
      Object.freeze(model);
    }
    Object.freeze(entry.models);
    return entry;
  });
