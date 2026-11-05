import { z } from "zod";

/**
 * Optional evidence for a stopped delegation; text remains readable by older peers. The code is
 * open ("usage_limited", "rate_limited", "provider_failed" today), so a newer peer's code reads
 * as a string here instead of failing the whole status batch it came in.
 */
export const DelegationFailure = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  accountId: z.string().max(256).optional(),
  accountLabel: z.string().max(256).optional(),
  resetsAt: z.number().nonnegative().optional(),
});
export type DelegationFailure = z.infer<typeof DelegationFailure>;
