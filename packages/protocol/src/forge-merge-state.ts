import { z } from "zod";
const text = z.string().max(65_536);
export const ForgeMergeState = z.object({
  headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  state: text,
  mergeState: text,
  reviewDecision: text.nullable(),
  checksState: text.nullable(),
  autoMerge: z.object({ method: text, actor: text.nullable(), enabledAt: text }).nullable(),
  queue: z
    .object({ id: text, state: text, position: z.number().int().nonnegative(), enqueuedAt: text })
    .nullable(),
  canEnable: z.boolean(),
  canDisable: z.boolean(),
  canDequeue: z.boolean(),
  blockers: z.array(text).max(20),
  raw: z.unknown(),
});
export type ForgeMergeState = z.infer<typeof ForgeMergeState>;
