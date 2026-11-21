import { orgAllows, type OrgPermission } from "@ace/client/ace-org";
import type { AceOrgSpace } from "@ace/protocol/ace-org";

/*
 * Spaces (ADR 0206 §1.4, §1.5), pure: a person's personal space is their own account; each
 * organization they are an active member of is another. A window shows one at a time. Switching
 * never signs anyone in or out, and leaving an organization only takes its space off the list.
 */

export const personalSpace = "personal";

/** The space a window shows: Personal, or one organization the person belongs to now. */
export type ShownSpace =
  | { id: typeof personalSpace; org: undefined }
  | { id: string; org: AceOrgSpace };

const personal: ShownSpace = { id: personalSpace, org: undefined };

/**
 * The space to show for what the window chose. An organization the list no longer has (the
 * person left or was removed) shows Personal; while the list is still on its way the choice
 * stands, so nothing of another space is drawn in the meantime, only the chosen one's own.
 */
export function shownSpace(
  chosen: string,
  spaces: readonly AceOrgSpace[] | undefined,
): ShownSpace | undefined {
  if (chosen === personalSpace) return personal;
  if (spaces === undefined) return undefined;
  const org = spaces.find((space) => space.id === chosen);
  return org ? { id: org.id, org } : personal;
}

/** A role in words, as the switcher and Members list it; one ace doesn't know is shown as given. */
export function roleWord(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  if (role === "billing") return "Billing";
  return role;
}

/** Whether the person's role in the shown organization allows `permission`; never in Personal. */
export function spaceAllows(space: ShownSpace | undefined, permission: OrgPermission): boolean {
  return space?.org !== undefined && orgAllows(space.org.role, permission);
}

/**
 * The machines a space shows (ADR 0206 §1.5, §8 "cross-space leakage"): an organization's space
 * only its hosts; Personal every machine that isn't a host of one of the person's organizations.
 * `hostsOf` maps each organization to its hosts' ids, or is missing one still loading: until an
 * organization's hosts are known, Personal shows none of the machines it can't place, and the
 * organization's own space shows nothing.
 */
export function machinesInSpace<T>(
  machines: readonly T[],
  hostIdOf: (machine: T) => string | undefined,
  space: ShownSpace | undefined,
  hostsOf: ReadonlyMap<string, ReadonlySet<string>>,
  orgs: readonly string[],
): T[] {
  if (space === undefined) return [];
  if (space.org) {
    const hosts = hostsOf.get(space.id);
    return hosts ? machines.filter((machine) => hosts.has(hostIdOf(machine) ?? "")) : [];
  }
  const known = orgs.every((org) => hostsOf.has(org));
  return machines.filter((machine) => {
    const id = hostIdOf(machine);
    // A machine with no relay id (paired over the LAN) is never an org host's account entry.
    if (id === undefined) return true;
    if (!known) return false;
    return !orgs.some((org) => hostsOf.get(org)?.has(id));
  });
}
