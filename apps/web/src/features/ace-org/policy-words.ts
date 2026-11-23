import { orgRole } from "@ace/client/ace-org";
import type { AceOrgPolicy } from "@ace/protocol/ace-org";

/*
 * What an organization's policy rule means for one member's switch on an install review
 * (ADR 0206 §3), pure. Reading the policy and its lists as lines is `@ace/ui-core/org`.
 */

/** The effects a policy rules on, as the install review's effect keys name them. */
export type PolicyEffect = keyof NonNullable<AceOrgPolicy["effects"]>;

const verbs: Record<PolicyEffect, string> = {
  network_without_hosts: "reaching sites a bot doesn't name",
  publish: "publishing",
  send_as_person: "sending in a member's name",
  pay: "paying",
  change_access: "changing who has access",
};

/** Members never turn these on, whatever the rule (ADR 0206 §3). */
const adminsOnly = new Set<PolicyEffect>(["pay", "send_as_person", "publish"]);

/**
 * Why `role` can't turn an effect's switch on, on an install review for one of the organization's
 * hosts, or undefined when they may. `off`: nobody may (`Acme doesn't allow paying.`); `admins`,
 * and paying, sending as a person and publishing for every member: only admins may. A declared
 * effect that only reaches the hosts it names is never `network_without_hosts`.
 */
export function effectLock(input: {
  policy: AceOrgPolicy;
  orgName: string;
  role: string;
  effect: string;
  /** The effect names the hosts it reaches. */
  namesHosts: boolean;
}): string | undefined {
  const key = policyEffectOf(input.effect, input.namesHosts);
  if (!key) return undefined;
  const rule = input.policy.effects?.[key];
  if (rule === "off") return `${input.orgName} doesn't allow ${verbs[key]}.`;
  const admin = orgRole(input.role) === "owner" || orgRole(input.role) === "admin";
  if (admin) return undefined;
  if (rule === "admins" || adminsOnly.has(key))
    return "Your organization lets only admins turn this on.";
  return undefined;
}

function policyEffectOf(effect: string, namesHosts: boolean): PolicyEffect | undefined {
  if (effect === "network") return namesHosts ? undefined : "network_without_hosts";
  return effect === "publish" ||
    effect === "send_as_person" ||
    effect === "pay" ||
    effect === "change_access"
    ? effect
    : undefined;
}
