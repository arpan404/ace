import type { ThreadId } from "@ace/protocol";
import type { Member } from "../account-access/member-grant.ts";

/*
 * Who is acting on an organization's host (ADR 0209 §3). Every socket and request resolves to
 * one principal, from what its caller proved. Pure: the facts are gathered by the transport.
 */

/** A fleet child capability the destination verified (ADR 0209 §6.2). */
export type ChildCapability = {
  org: string;
  /** The parent host it came from. */
  from: string;
  root: ThreadId;
  owner: string;
  child: ThreadId;
};

export type Principal =
  /** Not an org host: the policy steps aside and today's rules decide (§3, last bullet). */
  | { kind: "personal" }
  /** A member grant at admission and a standing proven here under the current owner. */
  | { kind: "member"; org: string; account: string; role: string }
  /** The daemon's own token: the host's operator. Metadata only; owns and answers nothing. */
  | { kind: "host" }
  /** An ace MCP bearer, bound to one tree when it was minted. */
  | { kind: "agent"; root: ThreadId }
  /** A fleet call from another host of the organization, on a verified child capability. */
  | { kind: "peer"; capability: ChildCapability }
  /** A member grant whose standing isn't proven on this socket, or has lapsed. */
  | { kind: "admitted"; org: string; account: string }
  /** Nothing this host recognises as anyone: an old paired device, an unknown bearer. */
  | { kind: "unproven" };

/** What a transport knows about its caller when it asks. */
export type PrincipalFacts = {
  /** The organization that owns this machine; undefined on a person's machine. */
  org: string | undefined;
  /** It authenticated with the daemon's own token (a loopback socket or an HTTP bearer). */
  hostToken?: boolean;
  /** The member its hello's grant admitted, if any. */
  admitted?: Member | undefined;
  /** The member whose standing is proven and current on this very socket or request. */
  proven?: Member | undefined;
  /** The tree an ace MCP bearer was minted for. */
  agentRoot?: ThreadId | undefined;
  /** A child capability the destination already verified against its roster and fleet keys. */
  capability?: ChildCapability | undefined;
};

/**
 * The one rule (ADR 0209 §3). Admission is not identity: a member counts only with a standing
 * proven on this socket for the account it was admitted as, so a replayed grant alone confers
 * nothing. The host's own token proving a member (the app on the host's desktop) becomes that
 * member; before that it is the host's operator.
 */
export function principal(facts: PrincipalFacts): Principal {
  const { org } = facts;
  if (org === undefined) return { kind: "personal" };
  const proven = facts.proven?.org === org ? facts.proven : undefined;
  const admitted = facts.admitted?.org === org ? facts.admitted : undefined;
  if (proven && (admitted ? admitted.account === proven.account : facts.hostToken === true))
    return { kind: "member", org, account: proven.account, role: proven.role };
  if (facts.agentRoot !== undefined) return { kind: "agent", root: facts.agentRoot };
  if (facts.capability?.org === org) return { kind: "peer", capability: facts.capability };
  if (facts.hostToken === true) return { kind: "host" };
  if (admitted) return { kind: "admitted", org, account: admitted.account };
  return { kind: "unproven" };
}
