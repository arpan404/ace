import { z } from "zod";
const text = z.string().max(65_536);
/**
 * The commit a merge or squash writes, as the person edited it. Absent, GitHub writes its
 * own. Rebase writes no new commit and takes none.
 */
export const ForgeMergeCommit = z.object({
  title: z.string().trim().min(1).max(1_024),
  message: text,
});
export type ForgeMergeCommit = z.infer<typeof ForgeMergeCommit>;
export const ForgeMergeState = z.object({
  headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  state: text,
  mergeState: text,
  reviewDecision: text.nullable(),
  checksState: text.nullable(),
  autoMerge: z.object({ method: text, actor: text.nullable(), enabledAt: text }).nullable(),
  queue: z
    .object({
      id: text,
      state: text,
      position: z.number().int().nonnegative(),
      enqueuedAt: text,
      estimatedTimeToMerge: z.number().int().nonnegative().nullable().optional(),
    })
    .nullable(),
  /** Branch protection and ruleset requirements in force while GitHub blocks the merge. */
  rules: z.array(text).max(20).optional(),
  /** The head commit's latest deployment in each environment. */
  deployments: z
    .array(z.object({ environment: text, state: text, url: text.nullable() }))
    .max(10)
    .optional(),
  canEnable: z.boolean(),
  canDisable: z.boolean(),
  canDequeue: z.boolean(),
  blockers: z.array(text).max(20),
  writeState: z.enum(["pending", "uncertain"]).optional(),
  /** GitHub's own prefill for this account's merge commit and squash commit. */
  commitMessages: z
    .object({ merge: ForgeMergeCommit.optional(), squash: ForgeMergeCommit.optional() })
    .optional(),
  raw: z.unknown(),
});
export type ForgeMergeState = z.infer<typeof ForgeMergeState>;
