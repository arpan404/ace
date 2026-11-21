import { orgAllows, orgRole, type OrgPermission } from "@ace/account-grant/org-roles";
import type { Member } from "./member-grant.ts";
import type { EnrollRefusal } from "./org-enrollment.ts";

/*
 * One socket's standing on an organization's host (ADR 0206 §2.2), and the rules that read it.
 * Pure: the clock and the owner's generation check are injected.
 */

/** Whether a WorkOS role slug is one of the organization's owners. */
export const orgOwner = (role: string): boolean => orgRole(role) === "owner";

/**
 * What only an organization's owners may do on its host (`host:shell`): its terminal and its
 * files. Owners prove it on the socket; the host's own token on loopback is its OS user, who has
 * the shell anyway.
 */
export function hostShellMessage(type: string): boolean {
  return type === "terminal.request" || type.startsWith("files.");
}

export const enrollRefusals: Record<EnrollRefusal, string> = {
  not_owner:
    "Only this machine's owner, proven on this connection, can give it to an organization.",
  signed_out: "Sign in to ace on this machine first.",
  unavailable: "Couldn't reach your ace account. Try again.",
};

/**
 * A member's standing proven on one socket: until the grant's expiry, under the owner generation
 * it was proven under. Deprovisioned, a member gets no fresh grant, so their standing (and with
 * it every stamp they could make) ends at the last one's expiry.
 */
export function orgStanding(deps: { now: () => number; holds: (generation: number) => boolean }) {
  let proven: { until: number; generation: number; member: Member } | undefined;
  const current = (): Member | undefined =>
    proven && proven.until > deps.now() && deps.holds(proven.generation)
      ? proven.member
      : undefined;
  return {
    /** Takes a proof begun under `generation`, unless the owner changed since. */
    prove(next: { until: number; generation: number; member: Member }): boolean {
      if (!deps.holds(next.generation)) return false;
      proven = next;
      return true;
    },
    /** The member this socket proved, while that still counts. */
    current,
    /** Their role, while their standing counts. */
    role: (): string | undefined => {
      const member = current();
      return member ? orgRole(member.role) : undefined;
    },
    /** Whether the proven member's role holds `permission` (ace's own table, never the token's). */
    allows: (permission: OrgPermission): boolean => {
      const member = current();
      return member !== undefined && orgAllows(member.role, permission);
    },
  };
}
