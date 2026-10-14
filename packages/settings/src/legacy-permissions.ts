import { accessRank, storedAccess } from "@ace/provider-kit/access-modes";
import { AccessMode, ProviderKind } from "@ace/protocol";
import { z } from "zod";

/** Settings keys replaced by `access.defaultMode` (ADR 0075). */
export const legacyAccessKeys = [
  "permissions.providerModes",
  "permissions.defaultMode",
  "approvals.policy",
] as const;

const ProviderModes = z.record(z.string(), z.string());
const Policy = z.enum(["ask", "on-failure", "never"]);

/**
 * The daemon default the old per-provider settings imply, mapped once on load: the most common
 * mapped provider mode (the stricter on a tie), else the old global mode or approval policy.
 */
export function legacyAccessDefault(settings: Record<string, unknown>): AccessMode | undefined {
  const modes = ProviderModes.safeParse(settings["permissions.providerModes"]);
  const counts = new Map<AccessMode, number>();
  for (const [key, id] of Object.entries(modes.success ? modes.data : {})) {
    const provider = ProviderKind.safeParse(key);
    const access = provider.success ? storedAccess(provider.data, id) : undefined;
    if (access) counts.set(access, (counts.get(access) ?? 0) + 1);
  }
  let best: [AccessMode, number] | undefined;
  for (const entry of counts)
    if (
      !best ||
      entry[1] > best[1] ||
      (entry[1] === best[1] && accessRank(entry[0]) < accessRank(best[0]))
    )
      best = entry;
  if (best) return best[0];
  const mode = AccessMode.safeParse(settings["permissions.defaultMode"]);
  if (mode.success) return mode.data;
  const policy = Policy.safeParse(settings["approvals.policy"]);
  if (!policy.success) return undefined;
  return policy.data === "never" ? "full-access" : policy.data === "ask" ? "ask" : "auto-review";
}
