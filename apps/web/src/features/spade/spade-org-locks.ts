import { useClient } from "@ace/client-react";
import type { SpadeDeclaredEffect } from "@ace/ui-core/spade-chat";
import { useSpace } from "@/features/ace-account/index.ts";
import { effectLock, readPolicy, useOrgPolicy } from "@/features/ace-org/index.ts";
import { useSpadeOrgOn } from "./spade-org-api.ts";

/** Why one declared effect's switch is locked, or undefined while the person may turn it on. */
export type EffectLockOf = (row: SpadeDeclaredEffect) => string | undefined;

/**
 * The install review's locks on this machine (ADR 0206 §3, §5.4): on an org host, an effect its
 * organization's policy turns off, or keeps for admins, can't be switched on by a member, and the
 * switch says why. Undefined on a personal machine: the organization's policy never applies there.
 * A role the window doesn't know yet is held to a member's.
 */
export function useEffectLocks(): EffectLockOf | undefined {
  const view = useSpadeOrgOn("primary", useClient()).data;
  const org = view?.org ?? undefined;
  const space = useSpace().spaces?.find((each) => each.id === org);
  const stored = useOrgPolicy(org).data;
  if (!org) return undefined;
  const policy = stored ? readPolicy(stored.body) : {};
  const orgName = view?.name || space?.name || "Your organization";
  const role = space?.role ?? "member";
  return (row) =>
    effectLock({
      policy,
      orgName,
      role,
      effect: row.effect,
      namesHosts: (row.hosts?.length ?? 0) > 0,
    });
}
