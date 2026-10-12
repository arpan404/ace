import { z } from "zod";
import { ForgePrRef, ForgeRepository } from "./forge.ts";
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
/** The selected PR identity and head are pinned, never inferred from a branch name. */
export const ForgePrWorktree = z.object({ ref: ForgePrRef, headSha: sha });
export type ForgePrWorktree = z.infer<typeof ForgePrWorktree>;
export const ForgePrCheckout = ForgePrWorktree.extend({
  baseSha: sha,
  headBranch: z.string().max(1024),
  baseBranch: z.string().max(1024),
  headRepository: ForgeRepository.nullable(),
});
export type ForgePrCheckout = z.infer<typeof ForgePrCheckout>;
/** Verified checkout and review context retained on the admitted task. */
export const ForgePrWorkspace = ForgePrCheckout.extend({
  context: z.string().max(65_536),
  contextTruncated: z.boolean(),
});
export type ForgePrWorkspace = z.infer<typeof ForgePrWorkspace>;
