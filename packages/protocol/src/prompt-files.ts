import { z } from "zod";
import { WorkspaceId } from "./ids.ts";
import { CommandDiagnostic } from "./command-library.ts";
export const PromptFileName = z
  .string()
  .min(4)
  .max(132)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/);
export const PromptFileScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), workspaceId: WorkspaceId }),
]);
export type PromptFileScope = z.infer<typeof PromptFileScope>;
export const PromptFile = z.object({
  name: PromptFileName,
  title: z.string().max(128),
  description: z.string().max(2048),
  scope: PromptFileScope,
  diagnostics: z.array(CommandDiagnostic).max(100),
});
export type PromptFile = z.infer<typeof PromptFile>;
export const PromptFileOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), workspaceId: WorkspaceId.optional() }),
  z.object({ op: z.literal("read"), scope: PromptFileScope, name: PromptFileName }),
  z.object({
    op: z.literal("write"),
    scope: PromptFileScope,
    name: PromptFileName,
    text: z.string().max(65536),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
]);
export type PromptFileOperation = z.infer<typeof PromptFileOperation>;
export const PromptFilesRequest = z.object({
  type: z.literal("prompts.request"),
  requestId: z.string().min(1).max(128),
  operation: PromptFileOperation,
});
export const PromptFileResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), files: z.array(PromptFile).max(256) }),
  z.object({
    kind: z.literal("file"),
    file: PromptFile,
    text: z.string().max(65536),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.literal("error"),
    code: z.enum(["unavailable", "forbidden", "not_found", "conflict", "limit"]),
    message: z.string().max(2048),
  }),
]);
export type PromptFileResult = z.infer<typeof PromptFileResult>;
export const PromptFilesResponse = z.object({
  type: z.literal("prompts.result"),
  requestId: z.string(),
  result: PromptFileResult,
});
