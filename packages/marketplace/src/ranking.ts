/*
 * The publisher tiers ranking takes a little into account (ADR 0173 §15), in one place. Each is a
 * bounded multiplier on a relevance or popularity score: a clearly more popular or more relevant
 * entry still outranks an official one, and among equals official ranks above verified above the
 * rest. Tiers never touch scanning, holds, blocks or the review before install.
 */

export const rankingTiers = {
  /** Published as `ace`, by an account on the signed official list (§14). */
  official: 1.3,
  /** A publisher on the signed verified list (§13). */
  verified: 1.1,
  /** Everyone else. */
  other: 1,
} as const;
export type RankingTier = keyof typeof rankingTiers;

/** The tier an entry's publisher is in: official before verified. */
export function tierOf(publisher: { official?: boolean; verified?: boolean }): RankingTier {
  if (publisher.official) return "official";
  if (publisher.verified) return "verified";
  return "other";
}

/** `score` with its tier's multiplier. */
export const tiered = (score: number, tier: RankingTier | undefined): number =>
  score * rankingTiers[tier ?? "other"];
