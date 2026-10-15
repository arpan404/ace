import { z } from "zod";
import type { QuotaResetCredits } from "@ace/protocol/accounts";

// Claude Code 2.1.301 reads this block from its own usage endpoint. A grant's
// resets_left is the saved balance; usable_now can be false until a limit is hit.
const status = z.object({
  eligible: z.boolean(),
  grants: z.array(z.unknown()).max(256),
});
const grant = z.object({
  resets_left: z.number().int().nonnegative().max(1_000_000),
  ends_at: z.string().max(64).nullable().optional(),
});

export function claudeResetCredits(value: unknown): QuotaResetCredits | undefined {
  const parsed = status.safeParse(value).data;
  if (!parsed) return undefined;
  let available = 0;
  let nextExpiresAt: number | null = null;
  for (const entry of parsed.grants) {
    const credit = grant.safeParse(entry).data;
    // An incomplete balance must not replace the last complete reading.
    if (!credit) return undefined;
    available += credit.resets_left;
    const expires = credit.ends_at ? Date.parse(credit.ends_at) : Number.NaN;
    if (
      credit.resets_left > 0 &&
      Number.isFinite(expires) &&
      (nextExpiresAt === null || expires < nextExpiresAt)
    )
      nextExpiresAt = expires;
  }
  return available <= 1_000_000 ? { available, nextExpiresAt } : undefined;
}
