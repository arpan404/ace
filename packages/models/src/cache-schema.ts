import { CatalogModel, ProviderKind } from "@ace/protocol";
import { z } from "zod";
import { freezeCatalogModel } from "./freeze.ts";

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
      // Before the execution-ID fix, OpenCode caches stored the bare model component.
      // Repair only that proven old shape, including fresh caches restored at startup.
      if (
        model.provider === "opencode" &&
        model.nativeProviderId &&
        model.id === `${model.nativeProviderId}/${model.nativeModelId}`
      )
        model.nativeModelId = model.id;
      freezeCatalogModel(model);
    }
    Object.freeze(entry.models);
    return entry;
  });
