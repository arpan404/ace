import { ProviderKind } from "./provider.ts";
import { z } from "zod";

export const PluginName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((value) => !value.includes("..") && !value.includes("--"))
  .meta({ "x-ace-constraint": "Plugin names cannot contain consecutive dots or hyphens." });
export const PluginCommit = z.string().regex(/^[a-f0-9]{40}$/);
export const PluginHash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(8192);
export const PluginExecution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hook"), event: text, command: text, matcher: text.optional() }),
  z.strictObject({
    kind: z.literal("stdio"),
    name: PluginName,
    command: text,
    args: z.array(text).max(128),
    env: z.record(z.string().max(128), text),
    cwd: text.optional(),
  }),
  z.strictObject({
    kind: z.literal("remote"),
    name: PluginName,
    type: z.enum(["http", "sse"]),
    url: text,
    headers: z.record(z.string().max(128), text),
  }),
]);
export const PluginReview = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  name: PluginName,
  version: z.string().max(128),
  commit: PluginCommit,
  hash: PluginHash,
  executions: z.array(PluginExecution).max(512),
  unsupported: z.array(text).max(512),
});
export type PluginReview = z.infer<typeof PluginReview>;
export const PluginReviewSummary = PluginReview.omit({
  executions: true,
  unsupported: true,
}).extend({
  executionCount: z.number().int().min(0).max(512),
  unsupportedCount: z.number().int().min(0).max(512),
});
export type PluginReviewSummary = z.infer<typeof PluginReviewSummary>;
export const PluginReviewEntry = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("execution"), execution: PluginExecution }),
  z.strictObject({ type: z.literal("diagnostic"), message: text }),
]);
export type PluginReviewEntry = z.infer<typeof PluginReviewEntry>;
export const PluginInstall = z.strictObject({
  name: PluginName,
  version: z.string().max(128),
  commit: PluginCommit,
  hash: PluginHash,
  acceptedAt: z.number().int().nonnegative(),
});
export type PluginInstall = z.infer<typeof PluginInstall>;
export const PluginReviewOffset = z.number().int().min(0).max(1024);
/** A plugin a repository's marketplace offers, before anything is fetched for review. */
export const PluginListing = z.strictObject({
  name: PluginName,
  description: text.optional(),
  version: z.string().max(128).optional(),
});
export type PluginListing = z.infer<typeof PluginListing>;
/**
 * Where an installed plugin came from: the repository and ref given to `plugins.prepare`
 * ("HEAD" is the repository's default branch). A separate request rather than fields on
 * `PluginInstall`, so a client that predates it never receives a shape it rejects.
 */
export const PluginOrigin = z.strictObject({ name: PluginName, repository: text, ref: text });
export type PluginOrigin = z.infer<typeof PluginOrigin>;
export const PluginAvailability = z.object({
  name: PluginName,
  enabled: z.boolean(),
  providers: z.array(ProviderKind).max(ProviderKind.options.length),
});
export type PluginAvailability = z.infer<typeof PluginAvailability>;
/** A skill's own policy; its plugin's policy also applies at session startup. */
export const PluginSkillAvailability = z.object({
  plugin: PluginName,
  name: PluginName,
  enabled: z.boolean(),
  providers: PluginAvailability.shape.providers,
});
export type PluginSkillAvailability = z.infer<typeof PluginSkillAvailability>;
export const PluginComponent = z.object({
  plugin: PluginName,
  name: PluginName,
  kind: z.enum(["skill", "command", "agent", "rule"]),
  skillAvailability: PluginSkillAvailability.optional(),
  title: z.string().min(1).max(200).optional(),
  path: z.string().max(512),
  description: text,
  enabled: z.boolean(),
  providers: z.array(ProviderKind).max(ProviderKind.options.length),
});
export type PluginComponent = z.infer<typeof PluginComponent>;
export const PluginRequest = z.discriminatedUnion("type", [
  PluginSkillAvailability.extend({ type: z.literal("plugins.skillAvailability") }),
  z.strictObject({
    type: z.literal("plugins.availability"),
    name: PluginName,
    enabled: z.boolean(),
    providers: z.array(ProviderKind).max(ProviderKind.options.length),
  }),
  z.strictObject({
    type: z.literal("plugins.catalog"),
    offset: z.number().int().min(0).max(262144).default(0),
    limit: z.number().int().min(1).max(50).default(50),
  }),
  z.strictObject({
    type: z.literal("plugins.source"),
    name: PluginName,
    path: z.string().min(1).max(512),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(4).max(65536).default(65536),
  }),
  z.strictObject({
    type: z.literal("plugins.edit"),
    name: PluginName,
    path: z.string().min(1).max(512),
    expectedHash: PluginHash,
    text: z.string().max(262144),
  }),

  z.strictObject({ type: z.literal("plugins.update"), name: PluginName }),
  z.strictObject({ type: z.literal("plugins.origins") }),
  /** What a repository's marketplace offers. `ref` defaults to the remote's HEAD. */
  z.strictObject({
    type: z.literal("plugins.marketplace"),
    repository: text,
    ref: text.optional(),
  }),
  z.strictObject({ type: z.literal("plugins.cancel"), id: PluginReview.shape.id }),
  z.strictObject({
    type: z.literal("plugins.prepare"),
    repository: text,
    ref: text,
    name: PluginName,
  }),
  z.strictObject({
    type: z.literal("plugins.accept"),
    id: PluginReview.shape.id,
    commit: PluginCommit,
    hash: PluginHash,
  }),
  z.strictObject({ type: z.literal("plugins.remove"), name: PluginName }),
  z.strictObject({ type: z.literal("plugins.list") }),
  z.strictObject({
    type: z.literal("plugins.readReview"),
    id: PluginReview.shape.id,
    offset: PluginReviewOffset.default(0),
  }),
]);
export const PluginResponse = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("plugins.skillAvailability"),
    availability: PluginSkillAvailability,
  }),
  z.strictObject({ type: z.literal("plugins.availability"), availability: PluginAvailability }),
  z.strictObject({
    type: z.literal("plugins.catalog"),
    components: z.array(PluginComponent).max(50),
    nextOffset: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("plugins.source"),
    path: z.string().max(4096),
    hash: PluginHash,
    bytes: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative(),
    text: z.string().max(65536),
    readonly: z.literal(true),
    virtual: z.boolean().optional(),
    manifestPath: z.string().max(512).optional(),
  }),

  z.strictObject({ type: z.literal("plugins.cancelled"), id: PluginReview.shape.id }),
  z.strictObject({ type: z.literal("plugins.review"), review: PluginReview }),
  z.strictObject({ type: z.literal("plugins.installed"), install: PluginInstall }),
  z.strictObject({
    type: z.literal("plugins.list"),
    installs: z.array(PluginInstall).max(256),
    reviews: z.array(PluginReviewSummary).max(32),
    availability: z.array(PluginAvailability).max(256).optional(),
  }),
  z.strictObject({ type: z.literal("plugins.removed"), name: PluginName }),
  z.strictObject({
    type: z.literal("plugins.marketplace"),
    ref: text,
    plugins: z.array(PluginListing).max(256),
  }),
  z.strictObject({ type: z.literal("plugins.origins"), origins: z.array(PluginOrigin).max(256) }),
  z.strictObject({
    type: z.literal("plugins.reviewPage"),
    review: PluginReviewSummary,
    entries: z.array(PluginReviewEntry).max(1024),
    nextOffset: z.number().int().min(1).max(1024).optional(),
  }),
]);

export type PluginResponse = z.infer<typeof PluginResponse>;

export const PluginClientMessage = z.strictObject({
  type: z.literal("pluginRequest"),
  requestId: z.string().min(1).max(80),
  request: PluginRequest,
});
export type PluginClientMessage = z.infer<typeof PluginClientMessage>;
export const PluginServerMessage = z.strictObject({
  type: z.literal("pluginResult"),
  requestId: PluginClientMessage.shape.requestId,
  response: PluginResponse,
});
export type PluginServerMessage = z.infer<typeof PluginServerMessage>;
