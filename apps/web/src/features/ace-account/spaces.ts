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
 * organization's own space shows nothing. `orgs` is undefined while the list of organizations
 * itself is on its way: Personal then places only the machines with no relay id.
 */
export function machinesInSpace<T>(
  machines: readonly T[],
  hostIdOf: (machine: T) => string | undefined,
  space: ShownSpace | undefined,
  hostsOf: ReadonlyMap<string, ReadonlySet<string>>,
  orgs: readonly string[] | undefined,
): T[] {
  if (space === undefined) return [];
  if (space.org) {
    const hosts = hostsOf.get(space.id);
    return hosts ? machines.filter((machine) => hosts.has(hostIdOf(machine) ?? "")) : [];
  }
  const known = orgs !== undefined && orgs.every((org) => hostsOf.has(org));
  return machines.filter((machine) => {
    const id = hostIdOf(machine);
    // A machine with no relay id (paired over the LAN) is never an org host's account entry.
    if (id === undefined) return true;
    if (!known) return false;
    return !orgs?.some((org) => hostsOf.get(org)?.has(id));
  });
}

/**
 * The organization whose hosts include `hostId`, from the same hosts map `machinesInSpace` reads;
 * undefined for Personal, or for a machine with no relay id (paired over the LAN).
 */
export function orgOfHost(
  hostId: string | undefined,
  spaces: readonly AceOrgSpace[],
  hostsOf: ReadonlyMap<string, ReadonlySet<string>>,
): AceOrgSpace | undefined {
  if (hostId === undefined) return undefined;
  return spaces.find((space) => hostsOf.get(space.id)?.has(hostId));
}

/** A name as its owner: "Acme Robotics'", "Dana's". */
export const possessive = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/**
 * Why a new thread can't start in the window's space, in one sentence, or undefined when it can
 * (ADR 0206 §2.4): a thread in an organization's space starts only on one of its machines, never
 * on this one in its place. `reachable` counts the space's machines this window lists.
 */
export function spaceStartBlock(
  space: ShownSpace | undefined,
  hostsOf: ReadonlyMap<string, ReadonlySet<string>>,
  reachable: number,
): string | undefined {
  if (space === undefined) return "Loading this organization's machines…";
  const org = space.org;
  if (!org) return undefined;
  const hosts = hostsOf.get(org.id);
  if (hosts === undefined) return `Loading ${possessive(org.name)} machines…`;
  if (hosts.size === 0) return `${org.name} has no machines yet.`;
  if (reachable === 0)
    return `None of ${possessive(org.name)} machines are connected to this window.`;
  return undefined;
}
