import { z } from "zod";
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const ForgeStackMembership = z.object({
  raw: z.unknown().optional(),
  number: z.number().int().positive(),
  stack: z
    .object({
      id: text,
      number: z.number().int().positive(),
      trunk: text,
      size: z.number().int().positive().max(100),
      position: z.number().int().positive().max(100),
    })
    .nullable(),
});
export type ForgeStackMembership = z.infer<typeof ForgeStackMembership>;
export const ForgeStackLayer = z.object({
  number: z.number().int().positive(),
  position: z.number().int().positive(),
  title: text,
  url: z.url().max(4096),
  headSha: sha,
  branch: text,
  baseBranch: text,
  state: text,
  mergeState: text,
  reviewDecision: text.nullable(),
  checksState: text.nullable(),
  requiredChecks: z
    .array(z.object({ name: text, state: text }))
    .max(20)
    .default([]),
  checksTruncated: z.boolean().default(false),
  queueState: text.nullable(),
});
export type ForgeStackLayer = z.infer<typeof ForgeStackLayer>;
export const ForgeLocalStack = z.object({
  trunk: text,
  currentBranch: text,
  raw: z.unknown().optional(),
  branches: z
    .array(
      z.object({
        name: text,
        head: sha,
        base: sha,
        isCurrent: z.boolean(),
        isMerged: z.boolean(),
        isQueued: z.boolean(),
        needsRebase: z.boolean(),
        pr: z
          .object({ number: z.number().int().positive(), url: z.url().max(4096), state: text })
          .optional(),
      }),
    )
    .max(100),
});
export type ForgeLocalStack = z.infer<typeof ForgeLocalStack>;
export const ForgeStackOperation = z.object({
  action: z.enum(["merge", "rebase", "continue", "abort", "push"]),
  state: z.enum([
    "pending",
    "merged",
    "enqueued",
    "failed",
    "uncertain",
    "conflict",
    "push_partial",
    "rebased",
    "aborted",
  ]),
  raw: z.unknown().optional(),
  uuid: z.uuid().optional(),
  stage: z.enum(["rebase", "push"]).optional(),
  message: text,
});
export type ForgeStackOperation = z.infer<typeof ForgeStackOperation>;
export const ForgeStack = z.object({
  id: text,
  number: z.number().int().positive(),
  trunk: text,
  layers: z.array(ForgeStackLayer).min(1).max(100),
  canMerge: z.boolean(),
  raw: z.unknown(),
});
export type ForgeStack = z.infer<typeof ForgeStack>;
export const ForgeStackWorkspace = z.object({
  stack: ForgeStack.nullable(),
  local: ForgeLocalStack.nullable(),
  localUnavailable: text.nullable(),
  operation: ForgeStackOperation.nullable(),
});
export type ForgeStackWorkspace = z.infer<typeof ForgeStackWorkspace>;
export const ForgeStackExpected = z.object({
  id: text,
  trunk: text,
  layers: z
    .array(z.object({ number: z.number().int().positive(), headSha: sha }))
    .min(1)
    .max(100),
  local: ForgeLocalStack.omit({ raw: true }).nullable(),
});
export type ForgeStackExpected = z.infer<typeof ForgeStackExpected>;
