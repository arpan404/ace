import { modelSource } from "./model-source.ts";
import { CatalogModel, ProviderKind, ModelSourceStatus, NativePermissionMode } from "@ace/protocol";
import { z } from "zod";
import { freezeCatalogModel } from "./freeze.ts";
import { discoveryError } from "./discovery-errors.ts";

export const CachedEntry = z
  .object({
    schemaVersion: z
      .union([z.literal(1), z.literal(2)])
      .default(2)
      .transform(() => 2),
    identityRevision: z.string().max(256).optional(),
    connectionRevision: z.string().max(256).optional(),
    sources: z.array(ModelSourceStatus).max(512).optional(),
    provider: ProviderKind,
    instance: z.string().min(1).max(256),
    loginRevision: z.string().min(1).max(256).optional(),
    revision: z.string().min(1).max(256),
    refreshedAt: z.number().nonnegative(),
    models: z.array(CatalogModel).max(512),
    permissionModes: z.array(NativePermissionMode).max(256).optional(),
  })
  .refine(
    (entry) =>
      entry.models.every(
        (model) => model.instance === entry.instance && model.provider === entry.provider,
      ) && new Set(entry.models.map((model) => model.id)).size === entry.models.length,
  )
  .transform((entry) => {
    const routes = new Map<string, Map<string, import("@ace/protocol").ModelSource>>();
    for (const model of entry.models) {
      if (model.source && model.source.kind !== "account") {
        const oldId = model.source.id;
        model.source = modelSource(model.nativeProviderId ?? oldId, model.id, model.source);
        const sources = routes.get(oldId) ?? new Map();
        sources.set(model.source.id, model.source);
        routes.set(oldId, sources);
      }
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
    // Expand legacy Ollama statuses into the model-specific local/cloud routes, before freezing.
    entry.sources = entry.sources?.flatMap((status) =>
      [
        ...(routes.get(status.source.id)?.values() ?? [
          modelSource(status.source.id, "", status.source),
        ]),
      ].map((source) => Object.assign({}, status, { source })),
    );
    for (const source of entry.sources ?? []) {
      if (source.error)
        source.error = discoveryError({ code: source.error.code }, source.error.code, {
          provider: entry.provider,
          source: source.source.id,
        });
      Object.freeze(source.source);
      if (source.error) Object.freeze(source.error);
      Object.freeze(source);
    }
    if (entry.sources) Object.freeze(entry.sources);
    Object.freeze(entry.models);
    return entry;
  });
