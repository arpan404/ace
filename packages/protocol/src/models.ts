import { z } from "zod";
import { ProviderKind } from "./provider.ts";

const label = z.string().min(1).max(256);
export const ModelTier = z.object({
  id: label,
  name: label,
  speed: z.enum(["standard", "fast"]).optional(),
  parameters: z
    .record(label, z.union([z.string().max(256), z.boolean()]))
    .default({})
    .refine((parameters) => Object.keys(parameters).length <= 16)
    .meta({ maxProperties: 16, "x-ace-constraint": "At most 16 entries." }),
});
export const CatalogModel = z
  .object({
    id: label,
    displayName: label,
    provider: ProviderKind,
    instance: label,
    nativeProviderId: label.optional(),
    nativeModelId: label,
    resolvedModelId: label.optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoningEfforts: z.array(label).max(32),
    defaultEffort: label.optional(),
    serviceTiers: z.array(ModelTier).max(32),
    defaultTier: label.optional(),
    inputModalities: z.array(label).max(16),
    isDefault: z.boolean(),
    hidden: z.boolean(),
    deprecated: z.boolean(),
    raw: z.object({
      json: z
        .string()
        .max(2048)
        .refine((json) => new TextEncoder().encode(json).byteLength <= 2048)
        .meta({ "x-ace-constraint": "UTF-8 encoding must be at most 2048 bytes." }),
      truncated: z.boolean(),
    }),
  })
  .refine(
    (model) => new TextEncoder().encode(JSON.stringify(model)).byteLength <= 8192,
    "Model row exceeds 8 KiB",
  )
  .meta({
    "x-ace-constraint":
      "The parsed model with defaults filled and unknown fields stripped must serialize to at most 8192 UTF-8 bytes of compact JSON.",
  });
export type CatalogModel = z.infer<typeof CatalogModel>;
export const ModelFilter = z.object({
  provider: ProviderKind.optional(),
  instance: label.optional(),
});
export type ModelFilter = z.infer<typeof ModelFilter>;
export const ModelListOptions = ModelFilter.extend({
  offset: z.number().int().min(0).max(32768).default(0),
  limit: z.number().int().min(1).max(100).default(100),
});
export type ModelListOptions = z.input<typeof ModelListOptions>;
export const ModelInstanceStatus = z.object({
  provider: ProviderKind,
  instance: label,
  refreshedAt: z.number().nonnegative().optional(),
  stale: z.boolean(),
  refreshing: z.boolean(),
  error: z.enum(["discovery_failed", "timeout", "persistence_failed"]).optional(),
});
export type ModelInstanceStatus = z.infer<typeof ModelInstanceStatus>;
export const ModelListResult = z.object({
  models: z.array(CatalogModel).max(100),
  instances: z.array(ModelInstanceStatus).max(64),
  nextOffset: z.number().int().nonnegative().optional(),
});
export type ModelListResult = z.infer<typeof ModelListResult>;
export const ModelRoleSpec = ModelFilter.extend({
  role: label,
  model: label.optional(),
  selection: z.enum(["default", "strongest"]).default("default"),
  /** Strongest first, maintained by the role policy owner, never inferred from names. */
  preferenceOrder: z.array(label).max(512).default([]),
  tier: label.optional(),
  effort: label.optional(),
  imageInput: z.boolean().default(false),
});
export type ModelRoleSpec = z.input<typeof ModelRoleSpec>;
export const ModelResolution = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    model: CatalogModel,
    tier: ModelTier.optional(),
    effort: label.optional(),
    stale: z.boolean(),
    reason: z.string().max(1024),
  }),
  z.object({ ok: z.literal(false), reason: z.string().max(1024) }),
]);
export type ModelResolution = z.infer<typeof ModelResolution>;
export const ModelsListRequest = z.object({
  type: z.literal("models.list"),
  requestId: label,
  options: ModelListOptions.default({ offset: 0, limit: 100 }),
});
export const ModelsRefreshRequest = z.object({
  type: z.literal("models.refresh"),
  requestId: label,
  filter: ModelFilter.default({}),
});
export const ModelsResolveRequest = z.object({
  type: z.literal("models.resolve"),
  requestId: label,
  roleSpec: ModelRoleSpec,
});
export const ModelsResult = z.object({
  type: z.literal("models.result"),
  requestId: label,
  result: z.union([ModelListResult, ModelResolution]),
});
