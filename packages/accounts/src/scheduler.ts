import { z } from "zod";
import type { ProviderInstance, AccountQuota } from "@ace/protocol/accounts";
import { availability, blockedUntil } from "./availability.ts";
import { object } from "./quota-decode.ts";

export type RolePolicy = Record<string, { speed: "standard" | "fast" }>;
export type Candidate = { instance: ProviderInstance; quota: AccountQuota };
const models = z.custom<unknown[]>(Array.isArray);
const modelName = z.string().min(1).max(256);
export function speedHint(
  provider: ProviderInstance["provider"],
  role: string,
  model: string,
  policy: RolePolicy,
  capabilities: { codexModelList?: unknown; claudeFastModels?: readonly string[] },
): { service_tier?: "priority"; fastMode?: true } {
  if (policy[role]?.speed !== "fast") return {};
  if (provider === "codex") {
    const data = models.safeParse(object(capabilities.codexModelList)["data"]).data;
    if (data && data.length <= 256)
      for (const value of data) {
        const row = object(value);
        if (modelName.safeParse(row["model"]).data !== model) continue;
        const tiers = models.safeParse(row["serviceTiers"]).data;
        if (
          tiers &&
          tiers.length <= 16 &&
          tiers.some((tier) => modelName.safeParse(object(tier)["id"]).data === "priority")
        )
          return { service_tier: "priority" };
      }
  }
  if (
    provider === "claude" &&
    capabilities.claudeFastModels &&
    capabilities.claudeFastModels.length <= 256 &&
    capabilities.claudeFastModels.includes(model)
  )
    return { fastMode: true };
  return {};
}
type Request = { provider: ProviderInstance["provider"]; role: string; estimatedLoad: number };

function checked(input: Request, count: number) {
  if (!Number.isFinite(input.estimatedLoad) || input.estimatedLoad < 0 || input.estimatedLoad > 100)
    throw new Error("Estimated load must be percentage points from 0 to 100");
  if (count > 256) throw new Error("Instance limit exceeded");
}

/** The least room left in any live window, in percentage points, and the soonest reset. */
function room(quota: AccountQuota, now: number) {
  let nextReset = Infinity;
  let headroom = 100;
  for (const window of Object.values(quota.windows)) {
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    headroom = Math.min(headroom, 100 - window.usedPercent);
    if (window.resetsAt !== null) nextReset = Math.min(nextReset, window.resetsAt);
  }
  return { nextReset, headroom };
}

/**
 * The account automatic choice runs a child on. First the available accounts with room for the
 * estimated load, spending the quota that resets soonest. When none has, any account still below
 * its limit (near it, or short of the estimated room) takes the work, the one with most room
 * first: a nearly used account is better than refusing. Only exhausted, signed-out, unconfirmed
 * or unusable accounts never run anything.
 */
export function pickInstance(
  input: Request,
  candidates: readonly Candidate[],
  now: number,
): ProviderInstance | undefined {
  checked(input, candidates.length);
  if (input.provider === "acp") return undefined; // ACP requires explicit agent/installation identity.
  let best: ProviderInstance | undefined;
  let bestReset = Infinity;
  let bestHeadroom = -Infinity;
  let fallback: ProviderInstance | undefined;
  let fallbackHeadroom = -Infinity;
  for (const { instance, quota } of candidates) {
    if (instance.provider !== input.provider) continue;
    const level = availability(quota, now);
    if (level !== "available" && level !== "near_limit") continue;
    const { nextReset, headroom } = room(quota, now);
    if (
      !fallback ||
      headroom > fallbackHeadroom ||
      (headroom === fallbackHeadroom && instance.id < fallback.id)
    ) {
      fallback = instance;
      fallbackHeadroom = headroom;
    }
    if (level !== "available" || headroom < input.estimatedLoad) continue;
    if (
      !best ||
      nextReset < bestReset ||
      (nextReset === bestReset &&
        (headroom > bestHeadroom || (headroom === bestHeadroom && instance.id < best.id)))
    ) {
      best = instance;
      bestReset = nextReset;
      bestHeadroom = headroom;
    }
  }
  return best ?? fallback;
}

/** What definitely keeps an account from taking work. */
export type AccountRefusal =
  | { reason: "other_provider" }
  | { reason: "home_unavailable" }
  | { reason: "signed_out" }
  | { reason: "sign_in_unconfirmed" }
  | { reason: "at_limit"; until: number | null };

/**
 * What definitely keeps an account from working at `now`, or undefined when nothing does: another
 * provider, an unusable home, a signed-out CLI, or a limit the provider said is reached (a fresh
 * full window or its usage-limit error). Being near a limit, an unread quota or too little room
 * for an estimate never does.
 */
export function definiteRefusal(
  provider: ProviderInstance["provider"],
  candidate: Candidate,
  now: number,
): AccountRefusal | undefined {
  const { instance, quota } = candidate;
  if (provider === "acp" || instance.provider !== provider) return { reason: "other_provider" };
  if (quota.blockers.homeUnavailable) return { reason: "home_unavailable" };
  if (quota.auth === "logged_out") return { reason: "signed_out" };
  const until = blockedUntil(quota, now);
  return until === undefined ? undefined : { reason: "at_limit", until };
}

/**
 * Why automatic choice passed an account over: its definite refusal, else that its sign-in is
 * not confirmed yet (automatic choice only runs work on accounts known to be signed in).
 */
export function automaticRefusal(
  provider: ProviderInstance["provider"],
  candidate: Candidate,
  now: number,
): AccountRefusal {
  return definiteRefusal(provider, candidate, now) ?? { reason: "sign_in_unconfirmed" };
}

/**
 * An account the person or an agent named. It runs the work unless something definite blocks it
 * (see `definiteRefusal`): near its limit, an unread quota or an estimate above its room never
 * refuses a choice someone made.
 */
export function explicitInstance(
  input: Request,
  candidate: Candidate,
  now: number,
): { instance: ProviderInstance } | { refusal: AccountRefusal } {
  checked(input, 1);
  const refusal = definiteRefusal(input.provider, candidate, now);
  return refusal ? { refusal } : { instance: candidate.instance };
}
