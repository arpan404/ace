import { z } from "zod";

export const PluginName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((value) => !value.includes("..") && !value.includes("--"));
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
export const PluginInstall = z.strictObject({
  name: PluginName,
  version: z.string().max(128),
  commit: PluginCommit,
  hash: PluginHash,
  acceptedAt: z.number().int().nonnegative(),
});
export type PluginInstall = z.infer<typeof PluginInstall>;
export const PluginRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("plugins.update"), name: PluginName }),
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
]);
export const PluginResponse = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("plugins.cancelled"), id: PluginReview.shape.id }),
  z.strictObject({ type: z.literal("plugins.review"), review: PluginReview }),
  z.strictObject({ type: z.literal("plugins.installed"), install: PluginInstall }),
  z.strictObject({
    type: z.literal("plugins.list"),
    installs: z.array(PluginInstall).max(256),
    reviews: z.array(PluginReview).max(32),
  }),
  z.strictObject({ type: z.literal("plugins.removed"), name: PluginName }),
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
