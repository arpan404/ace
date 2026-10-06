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
export function pickInstance(
  input: { provider: ProviderInstance["provider"]; role: string; estimatedLoad: number },
  candidates: readonly Candidate[],
  now: number,
): ProviderInstance | undefined {
  if (!Number.isFinite(input.estimatedLoad) || input.estimatedLoad < 0 || input.estimatedLoad > 100)
    throw new Error("Estimated load must be percentage points from 0 to 100");
  if (candidates.length > 256) throw new Error("Instance limit exceeded");
  if (input.provider === "acp") return undefined; // ACP requires explicit agent/installation identity.
  let best: ProviderInstance | undefined;
  let bestReset = Infinity;
  let bestHeadroom = -1;
  for (const { instance, quota } of candidates) {
    if (instance.provider !== input.provider || availability(quota, now) !== "available") continue;
    let nextReset = Infinity;
    let headroom = 100;
    for (const window of Object.values(quota.windows)) {
      if (window.resetsAt !== null && window.resetsAt <= now) continue;
      headroom = Math.min(headroom, 100 - window.usedPercent);
      if (window.resetsAt !== null) nextReset = Math.min(nextReset, window.resetsAt);
    }
    if (headroom < input.estimatedLoad) continue;
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
  return best;
}

/** Explicit selection of the normal CLI home needs no prior quota probe.
 * Known authentication failures and live quota blockers still prevent launch. */
export function explicitInstance(
  input: { provider: ProviderInstance["provider"]; role: string; estimatedLoad: number },
  candidate: Candidate,
  now: number,
): ProviderInstance | undefined {
  const selected = pickInstance(input, [candidate], now);
  if (selected || !candidate.instance.implicit || candidate.quota.auth !== "unknown")
    return selected;
  if (candidate.instance.provider !== input.provider) return undefined;
  return blockedUntil(candidate.quota, now) === undefined ? candidate.instance : undefined;
}
