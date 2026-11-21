import {
  AceOrgCreateRequest,
  AceOrgInvitationRequest,
  AceOrgPortalRequest,
  AceOrgRoleChange,
} from "@ace/protocol/ace-org";
import type { AceOrgInvitation, AceOrgPortalIntent } from "@ace/protocol/ace-org";
import { orgAllows, orgRole } from "@ace/account-grant/org-roles";
import type { OrgPermission } from "@ace/account-grant/org-roles";
import { invitationToken } from "./login.ts";
import type { Member, OrgAccess } from "./org-access.ts";
import type { OrgAudit } from "./org-audit.ts";
import type { OrgStore } from "./org-store.ts";
import { joinPage, page } from "./pages.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { PrincipalReader } from "./principal.ts";
import { WorkosRefusal } from "./workos-orgs.ts";
import type { WorkosInvitation, WorkosOrgs } from "./workos-orgs.ts";

/** An Admin Portal link lasts five minutes (WorkOS). */
const PORTAL_LINK_MS = 5 * 60_000;
/** Who may open each Admin Portal intent (ADR 0206 §2.7). */
const portalPermission: Record<AceOrgPortalIntent, OrgPermission> = {
  sso: "sso:manage",
  dsync: "sso:manage",
  domain_verification: "sso:manage",
  certificate_renewal: "sso:manage",
  log_streams: "sso:manage",
  audit_logs: "audit:read",
};

const invitation = (raw: WorkosInvitation): AceOrgInvitation => ({
  id: raw.id,
  email: raw.email,
  ...(raw.role_slug ? { role: raw.role_slug } : {}),
  state: raw.state,
  expiresAt: raw.expires_at,
});

/**
 * Organizations, members, invitations and Admin Portal links (ADR 0206 §1, §2.7, §6). WorkOS is
 * the authority: every change is made there first, then mirrored. Removing a member deletes the
 * membership, never deactivates it (deactivating would end all their WorkOS sessions, personal
 * ones too), and nothing here touches a member's personal data.
 */
export function orgRoutes(deps: {
  principals: PrincipalReader;
  access: OrgAccess;
  orgs: OrgStore;
  workos: WorkosOrgs;
  audit: OrgAudit;
  now: () => number;
}) {
  const { access, orgs, workos, audit, now } = deps;
  const actor = ({ principal }: Member) => ({
    type: "member",
    id: principal.account.id,
    name: principal.account.name || principal.account.email,
  });
  const iso = () => new Date(now()).toISOString();

  /** Whether `member` may change `target`'s membership to `role` (undefined: remove it). */
  async function guard(
    member: Member,
    target: { role: string; directory_managed: number },
    role: string | undefined,
  ): Promise<Response | undefined> {
    if (target.directory_managed === 1) return fail(409, "directory_managed");
    const touchesOwner = orgRole(target.role) === "owner" || role === "owner";
    if (touchesOwner && !orgAllows(member.role, "org:owners")) return fail(403, "forbidden");
    const losesOwner = orgRole(target.role) === "owner" && role !== "owner";
    if (losesOwner && (await orgs.activeOwners(member.org)) <= 1) return fail(409, "last_owner");
    return undefined;
  }

  return {
    /** GET /v1/orgs — the account's spaces, from the mirror. */
    async list(request: Request): Promise<Response> {
      const token = bearer(request);
      const principal = token ? await deps.principals.read(token) : undefined;
      if (!principal) return fail(401, "unauthenticated");
      // A machine credential belongs to no space but its own machine's.
      if (principal.kind === "machine") return json(200, { orgs: [] });
      return json(200, { orgs: await orgs.spaces(principal.account.id) });
    },

    /** POST /v1/orgs — a new organization, with the person as its owner (ADR 0206 §1.1). */
    async create(request: Request): Promise<Response> {
      const principal = await access.person(request);
      if (principal instanceof Response) return principal;
      if (principal.account.emailVerified !== true) return fail(403, "email_unverified");
      const body = AceOrgCreateRequest.safeParse(await jsonBody(request, 4096));
      if (!body.success) return fail(400, "invalid_request");
      const created = await workos.createOrganization(body.data.name);
      let membership;
      try {
        membership = await workos.createMembership(principal.account.id, created.id, "owner");
      } catch (error) {
        // An organization nobody owns is of no use: take it back.
        await workos.deleteOrganization(created.id).catch(() => {});
        throw error;
      }
      const version = membership.updated_at ?? iso();
      await orgs.run([
        orgs.upsertingOrg(
          {
            id: created.id,
            name: created.name,
            createdBy: principal.account.id,
            version: created.updated_at ?? version,
          },
          now(),
        ),
        orgs.upsertingMember(
          {
            org: created.id,
            account: principal.account.id,
            membership: membership.id,
            role: "owner",
            status: membership.status,
            directoryManaged: false,
            email: principal.account.email,
            name: principal.account.name,
            version,
          },
          now(),
        ),
      ]);
      // One year of audit history by default (ADR 0206 §4.3); owners may raise it.
      await workos.setAuditRetention(created.id, "1_YEAR").catch(() => {
        console.warn(JSON.stringify({ event: "org_retention_unset" }));
      });
      return json(201, {
        id: created.id,
        name: created.name,
        role: "owner",
        plan: "pilot",
        directoryManaged: false,
      });
    },

    /** GET /v1/orgs/{org}/members — every member may see who else is. */
    members: (request: Request, org: string) =>
      access.member(request, org, undefined, async (member) =>
        json(200, { members: await orgs.members(member.org) }),
      ),

    /** PATCH /v1/orgs/{org}/members/{account}. */
    changeRole: (request: Request, org: string, account: string) =>
      access.member(request, org, "members:manage", async (member) => {
        const body = AceOrgRoleChange.safeParse(await jsonBody(request, 1024));
        if (!body.success) return fail(400, "invalid_request");
        const target = await orgs.member(member.org, account);
        if (!target || target.status === "removed") return fail(404, "not_found");
        const refused = await guard(member, target, body.data.role);
        if (refused) return refused;
        const updated = await workos.updateMembershipRole(target.membership_id, body.data.role);
        await orgs.run([
          orgs.upsertingMember(
            {
              org: member.org,
              account,
              membership: updated.id,
              role: updated.role?.slug ?? body.data.role,
              status: updated.status,
              directoryManaged: updated.directory_managed === true,
              version: updated.updated_at ?? iso(),
            },
            now(),
          ),
          orgs.droppingChecks(member.org, account),
          orgs.flaggingOwners(member.org),
        ]);
        await audit.record(request, member.org, {
          action: "org.member.role_changed",
          actor: actor(member),
          targets: [{ type: "member", id: account }],
          metadata: { role_before: target.role, role_after: body.data.role },
        });
        return json(200, { ok: true });
      }),

    /**
     * DELETE /v1/orgs/{org}/members/{account}: Remove, or Leave for one's own account. Deletes
     * the WorkOS membership and keeps a `removed` row; ends the admin's portal sessions.
     */
    remove: (request: Request, org: string, account: string) =>
      access.member(request, org, undefined, async (member) => {
        const self = account === member.principal.account.id;
        if (!self && !orgAllows(member.role, "members:manage")) return fail(403, "forbidden");
        const target = await orgs.member(member.org, account);
        if (!target || target.status === "removed") return fail(404, "not_found");
        // Leaving as the last owner is refused like removing them.
        const refused = await guard(member, target, undefined);
        if (refused) return refused;
        try {
          await workos.deleteMembership(target.membership_id);
        } catch (error) {
          if (error instanceof WorkosRefusal && error.status === 404) {
            // Already gone at WorkOS: mirror that.
          } else if (error instanceof WorkosRefusal && error.status === 422)
            return fail(409, "directory_managed");
          else throw error;
        }
        await orgs.run([
          orgs.removingMember(member.org, account, target.membership_id, iso()),
          orgs.droppingChecks(member.org, account),
          orgs.flaggingOwners(member.org),
        ]);
        if (orgAllows(target.role, "sso:manage"))
          await workos.revokePortal(member.org, account).catch(() => {});
        await audit.record(request, member.org, {
          action: "org.member.removed",
          actor: actor(member),
          targets: [{ type: "member", id: account }],
          metadata: { role_before: target.role },
        });
        return json(200, { ok: true });
      }),

    /** GET /v1/orgs/{org}/invitations. */
    invitations: (request: Request, org: string) =>
      access.member(request, org, "members:manage", async (member) =>
        json(200, {
          invitations: (await workos.listInvitations(member.org))
            .filter((each) => each.organization_id === member.org)
            .map(invitation),
        }),
      ),

    /** POST /v1/orgs/{org}/invitations — WorkOS sends the mail; only owners invite owners. */
    invite: (request: Request, org: string) =>
      access.member(request, org, "members:manage", async (member) => {
        const body = AceOrgInvitationRequest.safeParse(await jsonBody(request, 2048));
        if (!body.success) return fail(400, "invalid_request");
        if (body.data.role === "owner" && !orgAllows(member.role, "org:owners"))
          return fail(403, "forbidden");
        let sent;
        try {
          sent = await workos.sendInvitation({
            email: body.data.email,
            org: member.org,
            role: body.data.role,
            inviter: member.principal.account.id,
          });
        } catch (error) {
          if (error instanceof WorkosRefusal && error.status < 500)
            return fail(409, "invitation_refused");
          throw error;
        }
        await audit.record(request, member.org, {
          action: "org.member.invited",
          actor: actor(member),
          targets: [{ type: "invitation", id: sent.id }],
          metadata: { role_after: body.data.role },
        });
        return json(201, invitation(sent));
      }),

    /** DELETE /v1/orgs/{org}/invitations/{id}. */
    revokeInvitation: (request: Request, org: string, id: string) =>
      access.member(request, org, "members:manage", async (member) => {
        const found = await workos.getInvitation(id).catch((error: unknown) => {
          if (error instanceof WorkosRefusal && error.status === 404) return undefined;
          throw error;
        });
        // Another organization's invitation is not found here, whatever it is.
        if (!found || found.organization_id !== member.org) return fail(404, "not_found");
        await workos.revokeInvitation(id);
        return json(200, { ok: true });
      }),

    /** POST /v1/orgs/{org}/portal — tagged with the admin's account, so Remove can end it. */
    portal: (request: Request, org: string) =>
      access.member(request, org, undefined, async (member) => {
        const body = AceOrgPortalRequest.safeParse(await jsonBody(request, 1024));
        if (!body.success) return fail(400, "invalid_request");
        if (!orgAllows(member.role, portalPermission[body.data.intent]))
          return fail(403, "forbidden");
        const expiresAt = now() + PORTAL_LINK_MS;
        const link = await workos.portalLink(member.org, body.data.intent, member.principal.account.id);
        await audit.record(request, member.org, {
          action: "org.portal.opened",
          actor: actor(member),
          targets: [{ type: "organization", id: member.org }],
          metadata: { intent: body.data.intent },
        });
        return json(200, { link, expiresAt });
      }),

    /**
     * GET /v1/orgs/join?invitation_token= — the invitation link WorkOS mails. Shows who invited
     * the person to which organization; spends nothing.
     */
    async joinPage(url: URL): Promise<Response> {
      const token = url.searchParams.get("invitation_token") ?? "";
      const gone = () => page(410, "This invitation has expired or was already used.");
      if (!invitationToken.test(token)) return gone();
      const found = await workos.findInvitation(token).catch((error: unknown) => {
        if (error instanceof WorkosRefusal) return undefined;
        throw error;
      });
      if (!found?.organization_id || found.state !== "pending") return gone();
      const org =
        (await orgs.orgName(found.organization_id)) ??
        (await workos.getOrganization(found.organization_id)).name;
      const inviter = found.inviter_user_id
        ? await workos.getUser(found.inviter_user_id).then(
            (user) => [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email,
            () => undefined,
          )
        : undefined;
      return joinPage({ org, inviter, token });
    },
  };
}
