import { NativePermissionMode } from "./permissions.ts";
import { AcpIdentity } from "./agent-registry.ts";
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
export const ModelSource = z.object({
  /** False when the source is available without a sign-in or API key. */
  requiresAuth: z.boolean().optional(),
  service: z.enum(["opencode_go", "opencode_zen"]).optional(),
  kind: z.enum(["local", "subscription", "api_key", "account", "other"]),
  id: label,
  label,
});
export type ModelSource = z.infer<typeof ModelSource>;
export const ModelDiscoveryError = z.object({
  code: z.enum([
    "not_installed",
    "not_configured",
    "auth_expired",
    "unreachable",
    "cli_too_old",
    "rate_limited",
    "parse_failure",
    "timeout",
    "persistence_failed",
    "discovery_failed",
    "no_models",
  ]),
  message: z.string().min(1).max(256),
  hint: z.string().min(1).max(256),
  actionId: z.literal("provider.sign_in").optional(),
  severity: z.enum(["info", "warning"]).optional(),
});
export type ModelDiscoveryError = z.infer<typeof ModelDiscoveryError>;
export const ModelSourceStatus = z.object({
  source: ModelSource,
  status: z.enum(["fresh", "refreshing", "stale"]),
  lastRefreshedAt: z.number().nonnegative().optional(),
  error: ModelDiscoveryError.optional(),
});
export type ModelSourceStatus = z.infer<typeof ModelSourceStatus>;
export const CatalogModel = z
  .object({
    id: label,
    displayName: label,
    detail: label.optional(),
    family: label.optional(),
    version: label.optional(),
    tier: z.enum(["current", "legacy"]).optional(),
    sortKey: label.optional(),
    source: ModelSource.optional(),
    provider: ProviderKind,
    ...AcpIdentity.partial().shape,
    instance: label,
    nativeProviderId: label.optional(),
    nativeModelId: label,
    resolvedModelId: label.optional(),
    modelConfigId: label.optional(),
    selectorMethod: z.enum(["session/set_config_option", "session/set_model"]).optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoningEfforts: z.array(label).max(32),
    defaultEffort: label.optional(),
    serviceTiers: z.array(ModelTier).max(32),
    defaultTier: label.optional(),
    inputModalities: z.array(label).max(16),
    isDefault: z.boolean(),
    defaultSource: z.enum(["built-in", "user"]).optional(),
    aliases: z.array(label).max(32).optional(),
    group: z.enum(["current", "legacy"]).optional(),
    hidden: z.boolean(),
    favourite: z.boolean().optional(),
    custom: z.boolean().optional(),
    providerEnabled: z.boolean().optional(),
    visibilityReason: z
      .enum([
        "provider_disabled",
        "group_hidden",
        "model_hidden",
        "deprecated",
        "not_favourite",
        "provider_hidden",
      ])
      .optional(),
    legacy: z.boolean().optional(),
    deprecated: z.boolean(),
    /** The provider marks the model as newly released; pickers badge it. */
    isNew: z.boolean().optional(),
    /** The CLI reports this model as free to use. */
    free: z.boolean().optional(),
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
  ...AcpIdentity.partial().shape,
  provider: ProviderKind.optional(),
  instance: label.optional(),
});
export type ModelFilter = z.infer<typeof ModelFilter>;
export const ModelListOptions = ModelFilter.extend({
  offset: z.number().int().min(0).max(40960).default(0),
  limit: z.number().int().min(1).max(100).default(100),
});
export type ModelListOptions = z.input<typeof ModelListOptions>;
export const ModelInstanceStatus = z.object({
  permissionModes: z.array(NativePermissionMode).max(256).optional(),
  ...AcpIdentity.partial().shape,
  provider: ProviderKind,
  instance: label,
  refreshedAt: z.number().nonnegative().optional(),
  lastRefreshedAt: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["fresh", "refreshing", "stale"]).optional(),
  errorDetail: ModelDiscoveryError.optional(),
  sources: z.array(ModelSourceStatus).max(512).optional(),
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
/** Authenticated read sockets receive invalidations and re-read their own catalog pages. */
export const ModelsChanged = z.object({
  type: z.literal("models.changed"),
  filter: ModelFilter,
});
export const ModelsResult = z.object({
  type: z.literal("models.result"),
  requestId: label,
  result: z.union([ModelListResult, ModelResolution]),
});
