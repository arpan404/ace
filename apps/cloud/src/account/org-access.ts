import { AceOrgId } from "@ace/protocol/ace-org";
import { orgAllows } from "@ace/account-grant/org-roles";
import type { OrgPermission } from "@ace/account-grant/org-roles";
import type { OrgChecker } from "./org-check.ts";
import type { Principal, PrincipalReader } from "./principal.ts";
import { bearer, fail, json } from "./respond.ts";
import type { SessionStore } from "./sessions.ts";

/** The answer for an org check that didn't let the session in (ADR 0206 §1.4). */
export function orgRefusal(org: string, error: "not_member" | "org_sign_in_required" | "busy") {
  if (error === "org_sign_in_required") return json(403, { error, org });
  if (error === "busy") return fail(503, "busy");
  return fail(403, "not_member");
}

/** A person acting in an organization, with the role WorkOS just confirmed. */
export type Member = { principal: Principal & { kind: "session" }; org: string; role: string };

/**
 * Who may call an org route (ADR 0206 §1.4, §8): only the person's own session (`person`
 * standing, ADR 0190), never a machine credential or a session a machine kept, and only with a
 * WorkOS answer under 60 seconds old that the account is an active member. The role is
 * authorized from ace's own table.
 */
export function orgAccess(deps: {
  principals: PrincipalReader;
  sessionStore: Pick<SessionStore, "standingNow">;
  checker: OrgChecker;
  now: () => number;
}) {
  async function person(request: Request): Promise<Principal | Response> {
    const token = bearer(request);
    const principal = token ? await deps.principals.read(token) : undefined;
    if (!principal) return fail(401, "unauthenticated");
    if (principal.kind !== "session") return fail(403, "person_required");
    const standing = await deps.sessionStore.standingNow(principal.hash, deps.now());
    if (standing === undefined) return fail(401, "unauthenticated");
    if (standing !== "person") return fail(403, "person_required");
    return principal;
  }

  return {
    person,
    /** Runs `then` for an active member of `org` whose role allows `permission`, if given. */
    async member(
      request: Request,
      orgParam: string,
      permission: OrgPermission | undefined,
      then: (member: Member) => Promise<Response>,
    ): Promise<Response> {
      const org = AceOrgId.safeParse(orgParam);
      if (!org.success) return fail(404, "not_found");
      const principal = await person(request);
      if (principal instanceof Response) return principal;
      if (principal.kind !== "session") return fail(403, "person_required");
      const check = await deps.checker.check(principal, org.data);
      if (!check.ok) return orgRefusal(org.data, check.error);
      if (permission && !orgAllows(check.role, permission)) return fail(403, "forbidden");
      return then({ principal, org: org.data, role: check.role });
    },
  };
}
export type OrgAccess = ReturnType<typeof orgAccess>;
