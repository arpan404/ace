import type { MarketProfile, MarketResult } from "@ace/protocol/marketplace";
import type { Badges } from "./trust.ts";

/*
 * Whether the signed-in account is ace's own publisher (ADR 0174 §14), so its avatar in the bar
 * and the profile editor draws ace's logo like everywhere else. Decided from the signed official
 * list on this device; a flag the market itself put on a profile is dropped.
 */

function marked(profile: MarketProfile, badges: Badges): MarketProfile {
  const { official: _claimed, ...rest } = profile;
  return badges.official(profile.id) ? { ...rest, official: true } : rest;
}

/** A `me` or `profile` answer with its profile's official mark set from the signed list. */
export function markOwnProfile(result: MarketResult, badges: Badges): MarketResult {
  if (result.op !== "publish") return result;
  const { answer } = result;
  if (answer.kind === "profile")
    return { ...result, answer: { ...answer, profile: marked(answer.profile, badges) } };
  if (answer.kind === "me" && answer.me.profile)
    return {
      ...result,
      answer: { ...answer, me: { ...answer.me, profile: marked(answer.me.profile, badges) } },
    };
  return result;
}
