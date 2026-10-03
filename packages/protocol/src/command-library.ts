import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";

export const PaletteName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const PromptValue = z.union([z.string().max(16384), z.number().finite(), z.boolean()]);
export type PromptValue = z.infer<typeof PromptValue>;
export const PromptArguments = z
  .record(PaletteName, PromptValue)
  .refine((v) => Object.keys(v).length <= 64)
  .meta({ maxProperties: 64, "x-ace-constraint": "At most 64 arguments." });
export const PromptArgument = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().default(false),
    default: PromptValue.optional(),
  })
  .refine(
    (v) => v.default === undefined || typeof v.default === v.type,
    "Default must match argument type",
  )
  .meta({ "x-ace-constraint": "An argument default must have the declared type." });
export const PaletteCommand = z.object({
  id: z.string().min(1).max(256),
  name: PaletteName,
  description: z.string().max(2048),
  namespace: z.enum(["ace", "provider", "prompt"]),
  provider: z.union([ProviderKind, z.literal("any")]),
  arguments: z
    .record(PaletteName, PromptArgument)
    .refine((v) => Object.keys(v).length <= 64)
    .meta({ maxProperties: 64, "x-ace-constraint": "At most 64 arguments." }),
  argumentHint: z.string().max(1024).optional(),
  scope: z.enum(["builtin", "user", "workspace", "runtime"]),
});
export type PaletteCommand = z.infer<typeof PaletteCommand>;
export const CommandDiagnostic = z.object({
  source: z.string().max(256),
  message: z.string().max(2048),
});
export type CommandDiagnostic = z.infer<typeof CommandDiagnostic>;
export const CommandPlan = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native"),
    provider: ProviderKind,
    text: z.string().max(65536),
    metadata: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("prompt"), provider: ProviderKind, text: z.string().max(65536) }),
  z.object({
    kind: z.literal("ace"),
    action: PaletteName,
    arguments: PromptArguments,
    positional: z.array(z.string().max(16384)).max(64),
  }),
]);
export type CommandPlan = z.infer<typeof CommandPlan>;
export const CommandResolution = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: CommandPlan }),
  z.object({
    ok: z.literal(false),
    error: z.enum([
      "not_found",
      "unsupported_provider",
      "unsupported_command",
      "missing_argument",
      "invalid_argument",
      "limit_exceeded",
    ]),
    argument: z.string().optional(),
  }),
]);
export type CommandResolution = z.infer<typeof CommandResolution>;
const request = z.object({ requestId: z.string().min(1).max(128), threadId: ThreadId });
export const CommandsList = request
  .omit({ threadId: true })
  .extend({
    threadId: ThreadId.optional(),
    draft: z
      .object({
        draftId: z.string().min(1).max(128),
        workspaceId: WorkspaceId,
        provider: ProviderKind,
        instanceId: z.string().min(1).max(128).optional(),
      })
      .optional(),
    type: z.literal("commands.list"),
    query: z.string().max(256).default(""),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((value) => (value.threadId === undefined) !== (value.draft === undefined))
  .meta({ "x-ace-constraint": "Exactly one of threadId or draft is required." });
export const CommandsResolve = request.extend({
  type: z.literal("commands.resolve"),
  commandId: z.string().min(1).max(256),
  arguments: PromptArguments.default({}),
  positional: z.array(z.string().max(16384)).max(64).default([]),
});
export const CommandsListResult = z.object({
  type: z.literal("commands.list.result"),
  requestId: z.string(),
  commands: z.array(PaletteCommand).max(100),
  diagnostics: z.array(CommandDiagnostic).max(100),
});
export const CommandsResolveResult = z.object({
  type: z.literal("commands.resolve.result"),
  requestId: z.string(),
  result: CommandResolution,
});
