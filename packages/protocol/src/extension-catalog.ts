import { z } from "zod";
import { WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { CommandsList, PromptArguments, PaletteCommand } from "./command-library.ts";

export const CatalogKind = z.enum([
  "skill",
  "command",
  "plugin",
  "agent",
  "workflow",
  "mcp-tool",
  "builtin",
]);
export type CatalogKind = z.infer<typeof CatalogKind>;
export const CatalogInvocation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slash"), name: z.string().min(1).max(256) }),
  z.object({
    type: z.literal("skill"),
    name: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
  }),
  z.object({
    type: z.literal("mention"),
    name: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("plugin"), name: z.string().min(1).max(256) }),
  z.object({ type: z.literal("agent"), name: z.string().min(1).max(256) }),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1).max(256),
    server: z.string().max(256),
  }),
  z.object({
    type: z.literal("prompt"),
    commandId: z.string().min(1).max(256),
    parameters: PaletteCommand.shape.arguments.optional(),
  }),
  z.object({ type: z.literal("action"), action: z.string().min(1).max(128) }),
  z.object({ type: z.literal("unavailable"), reason: z.string().min(1).max(2048) }),
]);
export type CatalogInvocation = z.infer<typeof CatalogInvocation>;
export const CatalogEntry = z.object({
  id: z.string().min(1).max(256),
  kind: CatalogKind,
  name: z.string().min(1).max(256),
  description: z.string().max(2048),
  icon: z.string().max(4096).optional(),
  source: z.object({
    provider: z.union([ProviderKind, z.literal("ace")]),
    scope: z.enum(["global", "project", "plugin", "ace"]),
    path: z.string().max(4096).optional(),
    plugin: z.string().max(256).optional(),
  }),
  invocation: CatalogInvocation,
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;
/** Display metadata survives catalog changes. Invocation is always resolved by the daemon. */
export const CatalogMention = z.object({
  type: z.literal("mention"),
  entryId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  kind: CatalogKind,
  icon: z.string().max(4096).optional(),
  arguments: z.string().max(16384).default(""),
  values: PromptArguments.optional(),
  invocation: CatalogInvocation.optional(),
});
export type CatalogMention = z.infer<typeof CatalogMention>;
export const CatalogList = z
  .object({
    ...CommandsList.shape,
    type: z.literal("catalog.list"),
    workspace: z
      .object({
        workspaceId: WorkspaceId,
        provider: ProviderKind,
        instanceId: z.string().min(1).max(128).optional(),
      })
      .optional(),
    subscribe: z.boolean().default(false),
    limit: z.number().int().min(1).max(512).default(100),
  })
  .refine(
    (value) =>
      [value.threadId, value.draft, value.workspace].filter((target) => target !== undefined)
        .length === 1,
  )
  .meta({ "x-ace-constraint": "Exactly one of threadId, draft or workspace is required." });
export const CatalogUnsubscribe = z.object({
  type: z.literal("catalog.unsubscribe"),
  requestId: z.string().min(1).max(128),
});
const snapshot = z.object({
  requestId: z.string(),
  entries: z.array(CatalogEntry).max(512),
  stale: z.boolean(),
});
export const CatalogListResult = snapshot.extend({ type: z.literal("catalog.list.result") });
export const CatalogChanged = snapshot.extend({ type: z.literal("catalog.changed") });
