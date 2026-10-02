import { z } from "zod";
import type { ProviderInstance, AccountQuota } from "@ace/protocol/accounts";
import { availability } from "./quota.ts";

export type RolePolicy = Record<string, { speed: "standard" | "fast" }>;
export type Candidate = { instance: ProviderInstance; quota: AccountQuota };
const modelList = z
  .object({
    data: z.array(
      z
        .object({
          model: z.string(),
          serviceTiers: z.array(z.object({ id: z.string() }).passthrough()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export function speedHint(
  provider: ProviderInstance["provider"],
  role: string,
  model: string,
  policy: RolePolicy,
  capabilities: { codexModelList?: unknown; claudeFastModels?: readonly string[] },
): { service_tier?: "priority"; fastMode?: true } {
  if (policy[role]?.speed !== "fast") return {};
  if (provider === "codex") {
    const models = modelList.safeParse(capabilities.codexModelList).data;
    if (
      models?.data
        .find((m) => m.model === model)
        ?.serviceTiers?.some((tier) => tier.id === "priority")
    )
      return { service_tier: "priority" };
  }
  if (provider === "claude" && capabilities.claudeFastModels?.includes(model))
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
