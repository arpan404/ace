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

/** How long a member's standing stands before an answer on it is checked with the backend. */
export const MEMBER_RECHECK_MS = 60_000;

/** The backend's word on a member grant (`POST /v1/grants/standing`). */
export type MemberRecheck = (
  grant: string,
) => Promise<{ current: boolean; role?: string | undefined }>;

/**
 * A member's standing proven on one socket: until the grant's expiry, under the owner generation
 * it was proven under. Deprovisioned, a member gets no fresh grant, so their standing (and with
 * it every stamp they could make) ends at the last one's expiry. Before an answer is stamped,
 * `checked` asks the backend again about a standing older than {@link MEMBER_RECHECK_MS} (ADR
 * 0206 §8.1): a member the backend no longer has as active with this role, or a check that
 * can't be made, ends the standing there.
 */
export function orgStanding(deps: {
  now: () => number;
  holds: (generation: number) => boolean;
  recheck?: MemberRecheck;
}) {
  type Proven = {
    until: number;
    generation: number;
    member: Member;
    grant?: string | undefined;
    checkedAt: number;
  };
  let proven: Proven | undefined;
  /** When the backend last confirmed each recent grant; a few, newest last. */
  const confirmed = new Map<string, number>();
  const current = (): Member | undefined =>
    proven && proven.until > deps.now() && deps.holds(proven.generation)
      ? proven.member
      : undefined;
  return {
    /**
     * Takes a proof begun under `generation`, unless the owner changed since. Its freshness is
     * the backend's newest word on it: when the grant was minted (`issuedAt`, on a fresh org
     * check) or when the backend last confirmed this very grant. Proving the same grant again
     * never makes it fresher; without `issuedAt` it is checked at its first answer.
     */
    prove(next: {
      until: number;
      generation: number;
      member: Member;
      grant?: string;
      issuedAt?: number;
    }): boolean {
      if (!deps.holds(next.generation)) return false;
      const { issuedAt, ...rest } = next;
      const lastConfirmed = next.grant === undefined ? undefined : confirmed.get(next.grant);
      proven = {
        ...rest,
        checkedAt: Math.max(
          issuedAt ?? Number.NEGATIVE_INFINITY,
          lastConfirmed ?? Number.NEGATIVE_INFINITY,
        ),
      };
      return true;
    },
    /** The member this socket proved, while that still counts. */
    current,
    /**
     * The member, for an answer: as `current`, with a standing older than a minute confirmed
     * by the backend first. Fails closed.
     */
    async checked(): Promise<Member | undefined> {
      const held = proven;
      if (!held || current() === undefined) return undefined;
      if (deps.now() - held.checkedAt <= MEMBER_RECHECK_MS) return held.member;
      let answer: { current: boolean; role?: string | undefined } | undefined;
      try {
        answer = held.grant && deps.recheck ? await deps.recheck(held.grant) : undefined;
      } catch {
        answer = undefined;
      }
      // Proven again while the backend answered: that newer proof decides the next answer.
      if (proven !== held) return undefined;
      if (!answer?.current || answer.role !== held.member.role) {
        proven = undefined;
        return undefined;
      }
      held.checkedAt = deps.now();
      if (held.grant !== undefined) {
        confirmed.delete(held.grant);
        confirmed.set(held.grant, held.checkedAt);
        for (const grant of confirmed.keys()) {
          if (confirmed.size <= 8) break;
          confirmed.delete(grant);
        }
      }
      return current();
    },
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
