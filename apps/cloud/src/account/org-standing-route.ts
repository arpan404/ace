import {
  GrantError,
  verifyMarketGrant,
  verifyMemberGrant,
  type GrantKeySet,
} from "@ace/account-grant";
import { AceOrgStandingRequest } from "@ace/protocol/ace-org";
import type { OrgStore } from "./org-store.ts";
import { fail, json } from "./respond.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";

/** The member, organization and role an org grant speaks for, if it is one this backend signed. */
function grantMember(token: string, keys: GrantKeySet, now: number, issuer: string) {
  try {
    const claims = verifyMemberGrant(token, keys, now);
    return { org: claims.org, account: claims.account, role: claims.role };
  } catch (error) {
    if (!(error instanceof GrantError)) throw error;
  }
  try {
    const claims = verifyMarketGrant(token, keys, now, issuer);
    if (claims.org === undefined) return undefined;
    return { org: claims.org, account: claims.account, role: claims.orgRole ?? "" };
  } catch (error) {
    if (!(error instanceof GrantError)) throw error;
  }
  return undefined;
}

/**
 * POST /v1/grants/standing (ADR 0206 §6, §8.1): whether an unexpired org grant still speaks for
 * its member. An org host asks before it stamps an answer on a standing more than 60 seconds
 * old; the market asks before an org grant reads or writes a private registry. Current only when
 * the members mirror has the member active with the grant's role and WorkOS, asked now, names
 * that same membership, active, with that role. WorkOS not answering is 503, never a yes.
 */
export function orgStandingRoute(deps: {
  keys: GrantKeySet;
  issuer: string;
  orgs: Pick<OrgStore, "memberState">;
  workos: Pick<WorkosOrgs, "findMembership">;
  now: () => number;
  /**
   * The route's own limit, per member account once the grant verified: its callers are org
   * hosts and the market, which may each speak for many members from one address.
   */
  limited: (account: string) => Promise<boolean>;
}) {
  return async (request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, "invalid_request");
    }
    const parsed = AceOrgStandingRequest.safeParse(body);
    if (!parsed.success) return fail(400, "invalid_request");
    const member = grantMember(parsed.data.grant, deps.keys, deps.now(), deps.issuer);
    if (!member) return fail(400, "invalid_grant");
    if (await deps.limited(member.account)) return fail(429, "rate_limited");
    const row = await deps.orgs.memberState(member.org, member.account);
    if (row?.status !== "active" || row.role !== member.role) return json(200, { current: false });
    let found;
    try {
      found = await deps.workos.findMembership(member.account, member.org);
    } catch {
      return fail(503, "unavailable");
    }
    const current =
      found !== undefined &&
      found.id === row.membership &&
      found.user_id === member.account &&
      found.organization_id === member.org &&
      found.status === "active" &&
      (found.role?.slug ?? "member") === member.role;
    return json(200, current ? { current, role: member.role } : { current: false });
  };
}
