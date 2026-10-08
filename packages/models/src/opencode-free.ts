import { z } from "zod";

const price = z.number().nonnegative();
const cost = z.object({
  input: price,
  output: price,
  cache: z.object({ read: price, write: price }),
});
const metadata = z.object({
  providerID: z.string(),
  enabled: z.boolean(),
  cost: z.array(cost).min(1).max(128),
});

/** Zero pricing is credential-free evidence only for Zen, never for a paid subscription. */
export function freeOpenCodeModel(value: unknown): boolean {
  const parsed = metadata.safeParse(value);
  return Boolean(
    parsed.success &&
    parsed.data.enabled &&
    ["opencode", "opencode-zen"].includes(parsed.data.providerID) &&
    parsed.data.cost.every(
      (tier) =>
        tier.input === 0 && tier.output === 0 && tier.cache.read === 0 && tier.cache.write === 0,
    ),
  );
}
