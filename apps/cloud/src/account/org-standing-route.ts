import {
  GrantError,
  verifyMarketGrant,
  verifyMemberGrant,
  type GrantKeySet,
} from "@ace/account-grant";
import { AceOrgStandingRequest } from "@ace/protocol/ace-org";
import { digest, sameDigest } from "./crypto.ts";
import type { OrgStore } from "./org-store.ts";
import { bearer, boundedBody, fail, json } from "./respond.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";

/** The largest body read: a grant is well under 2 KiB. */
const MAX_BODY_BYTES = 16 * 1024;
/** WorkOS lookups this isolate has waiting at once; past it a check is refused, not queued. */
export const MAX_LOOKUPS_IN_FLIGHT = 4;

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

/** Who asks: the market, by its token, or an org host, by its organization credential. */
type Caller = { kind: "market" } | { kind: "host"; org: string };

/**
 * POST /v1/grants/standing (ADR 0206 §6, §8.1): whether an unexpired org grant still speaks for
 * its member. Asked by the market before an org grant reads or writes a private registry, and by
 * an org host, about its own organization's grants only, before it stamps an answer on a standing
 * more than a minute old. Anyone else is refused before the body is read, and limited by address.
 *
 * Current only when the members mirror has the member active with the grant's role, WorkOS,
 * asked now, names that same membership active with that role, and the mirror row is still the
 * one read before asking: a removal that lands while WorkOS answers makes the answer no. WorkOS
 * lookups are limited per caller and member, overall, and to a few at once; past any limit, and
 * when WorkOS can't answer, the route refuses rather than answering yes.
 */
export function orgStandingRoute(deps: {
  keys: GrantKeySet;
  issuer: string;
  orgs: Pick<OrgStore, "memberState">;
  workos: Pick<WorkosOrgs, "findMembership">;
  now: () => number;
  /** The market's token; without it the market isn't answered. */
  marketToken: string | undefined;
  /** The organization a bearer's org host credential speaks for; null for another credential. */
  hostOrg: (token: string) => Promise<string | null | undefined>;
  /** Limits on callers that don't authenticate, by address. */
  addressLimited: (request: Request) => Promise<boolean>;
  /** Limits per caller and member account. */
  limited: (key: string) => Promise<boolean>;
  /** Limits WorkOS lookups overall. */
  workosLimited: () => Promise<boolean>;
}) {
  let inFlight = 0;
  const marketDigest = deps.marketToken ? digest(deps.marketToken) : undefined;

  async function caller(request: Request): Promise<Caller | "unauthenticated" | "forbidden"> {
    const token = bearer(request);
    if (!token) return "unauthenticated";
    if (marketDigest && sameDigest(await digest(token), await marketDigest))
      return { kind: "market" };
    const org = await deps.hostOrg(token);
    if (org === undefined) return "unauthenticated";
    return org === null ? "forbidden" : { kind: "host", org };
  }

  return async (request: Request): Promise<Response> => {
    const who = await caller(request);
    if (typeof who === "string") {
      if (await deps.addressLimited(request)) return fail(429, "rate_limited");
      return who === "forbidden" ? fail(403, "forbidden") : fail(401, "unauthenticated");
    }
    const bytes = await boundedBody(request, MAX_BODY_BYTES);
    if (!bytes) return fail(413, "too_large");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return fail(400, "invalid_request");
    }
    const parsed = AceOrgStandingRequest.safeParse(body);
    if (!parsed.success) return fail(400, "invalid_request");
    const member = grantMember(parsed.data.grant, deps.keys, deps.now(), deps.issuer);
    if (!member) return fail(400, "invalid_grant");
    // A host asks only about its own organization's members.
    if (who.kind === "host" && who.org !== member.org) return fail(403, "forbidden");
    const callerKey = who.kind === "market" ? "market" : `host:${who.org}`;
    if (await deps.limited(`${callerKey}:${member.account}`)) return fail(429, "rate_limited");
    const before = await deps.orgs.memberState(member.org, member.account);
    if (before?.status !== "active" || before.role !== member.role)
      return json(200, { current: false });
    if (inFlight >= MAX_LOOKUPS_IN_FLIGHT || (await deps.workosLimited())) return fail(503, "busy");
    let found;
    inFlight++;
    try {
      found = await deps.workos.findMembership(member.account, member.org);
    } catch {
      return fail(503, "unavailable");
    } finally {
      inFlight--;
    }
    // The row must still be the one read before WorkOS was asked.
    const after = await deps.orgs.memberState(member.org, member.account);
    const current =
      found !== undefined &&
      after !== undefined &&
      after.seq === before.seq &&
      after.status === "active" &&
      after.role === member.role &&
      after.membership === before.membership &&
      found.id === after.membership &&
      found.user_id === member.account &&
      found.organization_id === member.org &&
      found.status === "active" &&
      (found.role?.slug ?? "member") === member.role;
    return json(200, current ? { current, role: member.role } : { current: false });
  };
}
