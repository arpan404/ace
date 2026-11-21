import { orgRole } from "@ace/client/ace-org";
import { AceOrgPolicy } from "@ace/protocol/ace-org";

/*
 * An organization's policy in the app (ADR 0206 §3), pure: reading the stored text, the lines
 * the page edits lists as, and what a policy rule means for one member's switch on an install
 * review. A policy only narrows, so a part ace can't read is shown as unset and left as it was.
 */

/** The stored version's text as a policy; a text this build can't read is no ceiling of its own. */
export function readPolicy(body: string): AceOrgPolicy {
  try {
    const parsed = AceOrgPolicy.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Lines of a list field: trimmed, blank ones dropped, each once. */
export function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

type Allow = NonNullable<NonNullable<AceOrgPolicy["packages"]>["allow"]>[number];
type Block = NonNullable<NonNullable<AceOrgPolicy["packages"]>["block"]>[number];
const sourceOf = (word: string): Allow["source"] | undefined =>
  word === "market" || word === "registry" || word === "git" ? word : undefined;

/** "market spade-bot/ci-watcher" per line; a line without a known source is from the market. */
export function allowEntries(text: string): Allow[] {
  return lines(text).map((line) => {
    const [first = "", ...rest] = line.split(/\s+/);
    const source = sourceOf(first);
    if (source && rest.length > 0) return { source, name: rest.join(" ") };
    return { source: "market", name: line };
  });
}
export const allowText = (allow: readonly Allow[] | undefined) =>
  (allow ?? []).map((entry) => `${entry.source} ${entry.name}`).join("\n");

/** A `sha256:…` line blocks that exact archive; any other line blocks a package by name. */
export function blockEntries(text: string): Block[] {
  return lines(text).map((line) =>
    /^sha256:[0-9a-f]{64}$/.test(line) ? { hash: line } : { name: line },
  );
}
export const blockText = (block: readonly Block[] | undefined) =>
  (block ?? []).map((entry) => ("hash" in entry ? entry.hash : entry.name)).join("\n");

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
