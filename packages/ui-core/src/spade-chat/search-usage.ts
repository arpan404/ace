import { z } from "zod";
import { spadeJson } from "./json.ts";

/**
 * This month's ace searches, from Spade's `GET /v1/usage/search` (ADR 0210 §6). Spade says null
 * for what it doesn't know yet, such as before its first search this month.
 */
export interface SpadeSearchUsage {
  signedIn: boolean;
  used: number | null;
  allowance: number | null;
  resetsAt: string | null;
}

const count = z.number().int().nonnegative().nullish().catch(null);

const usageShape = z.object({
  signed_in: z.boolean(),
  used: count,
  allowance: count,
  resets_at: z.string().nullish().catch(null),
});

/** Spade's answer read leniently: unknown fields ignored, a bad count unknown, garble undefined. */
export function parseSpadeSearchUsage(body: string): SpadeSearchUsage | undefined {
  const parsed = usageShape.safeParse(spadeJson(body));
  if (!parsed.success) return undefined;
  return {
    signedIn: parsed.data.signed_in,
    used: parsed.data.used ?? null,
    allowance: parsed.data.allowance ?? null,
    resetsAt: parsed.data.resets_at ?? null,
  };
}

const counted = new Intl.NumberFormat("en-US");

/**
 * The one quiet line Settings › Spade › General shows, or undefined when Spade can't say:
 * "ace search: 312 of 1,000 searches this month", or the sign-in sentence when signed out.
 */
export function spadeSearchUsageLine(usage: SpadeSearchUsage | undefined): string | undefined {
  if (!usage) return undefined;
  if (!usage.signedIn) return "Sign in to ace to search the web.";
  if (usage.used === null || usage.allowance === null) return undefined;
  return `ace search: ${counted.format(usage.used)} of ${counted.format(usage.allowance)} searches this month`;
}
