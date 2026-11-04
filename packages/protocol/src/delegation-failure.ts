import { z } from "zod";

/** Optional evidence for a stopped delegation; text remains readable by older peers. */
export const DelegationFailure = z.object({
  code: z.enum(["usage_limited", "provider_failed"]),
  message: z.string().min(1).max(512),
  accountId: z.string().max(256).optional(),
  accountLabel: z.string().max(256).optional(),
  resetsAt: z.number().nonnegative().optional(),
});
export type DelegationFailure = z.infer<typeof DelegationFailure>;
