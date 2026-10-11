import { z } from "zod";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"))
  .meta({ "x-ace-constraint": "Path without NUL bytes." });
export const SourceControlSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), paths: z.array(path).min(1).max(1000) }),
  z.object({
    kind: z.literal("pr"),
    branch: z.string().min(1).max(256),
    base: z.string().min(1).max(256),
    /** Git revision for the base; distinct from the forge's branch name. */
    baseRef: z.string().min(1).max(1200).optional(),
  }),
]);
export type SourceControlSelection = z.infer<typeof SourceControlSelection>;
export const SourceControlContext = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().nullable(),
  base: z.string().nullable(),
  paths: z.array(path).max(1000),
  patch: z.string().max(65536),
  truncated: z.boolean(),
  conventions: z.array(z.object({ path, text: z.string().max(16384) })).max(32),
  recentCommits: z.string().max(8192),
});
export type SourceControlContext = z.infer<typeof SourceControlContext>;
export const SourceControlDraft = z.object({
  subject: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0 && !/[\r\n\0]/.test(value))
    .meta({ "x-ace-constraint": "Single line without NUL bytes." }),
  body: z
    .string()
    .max(7800)
    .refine((value) => !value.includes("\0"))
    .meta({ "x-ace-constraint": "Text without NUL bytes." }),
});
export type SourceControlDraft = z.infer<typeof SourceControlDraft>;
export const SourceControlDraftInput = z.object({
  generationId: z.string().min(1).max(128),
  selection: SourceControlSelection,
  fingerprint: SourceControlContext.shape.fingerprint,
  provider: z.enum(["claude", "codex"]),
  model: z.string().min(1).max(256).optional(),
  preference: z.string().max(2048).default(""),
});
export type SourceControlDraftInput = z.infer<typeof SourceControlDraftInput>;
