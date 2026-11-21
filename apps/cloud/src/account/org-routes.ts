import {
  AceOrgCreateRequest,
  AceOrgInvitationRequest,
  AceOrgPortalRequest,
  AceOrgRoleChange,
} from "@ace/protocol/ace-org";
import type { AceOrgInvitation } from "@ace/protocol/ace-org";
import { orgAllows, orgRole } from "@ace/account-grant/org-roles";
import { invitationToken } from "./login.ts";
import type { Member, OrgAccess } from "./org-access.ts";
import type { OrgAudit } from "./org-audit.ts";
import type { OrgLocks } from "./org-locks.ts";
import { opensPortal, portalPermission } from "./org-portal.ts";
import type { PortalRevocations } from "./org-portal.ts";
import type { OrgStore } from "./org-store.ts";
import { joinPage, page } from "./pages.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { PrincipalReader } from "./principal.ts";
import { WorkosRefusal } from "./workos-orgs.ts";
import type { WorkosInvitation, WorkosMembership, WorkosOrgs } from "./workos-orgs.ts";

/** An Admin Portal link lasts five minutes (WorkOS). */
const PORTAL_LINK_MS = 5 * 60_000;
/**
 * One membership change at a time per organization, across isolates. Each holds it through a
 * few WorkOS calls of at most ten seconds each; others wait up to five seconds for it.
 */
const MEMBERS_LEASE = { ms: 60_000, tries: 25, waitMs: 200 };

const actor = ({ principal }: Member) => ({
  type: "member",
  id: principal.account.id,
  name: principal.account.name || principal.account.email,
});
const gone = () => page(410, "This invitation has expired or was already used.");

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
 *
 * Membership changes run one at a time per organization (`members:<org>`), and each decides on
 * WorkOS's membership and owners read inside that turn, never the mirror's: two owners leaving
 * at once can't both pass "another owner remains".
 */
export function orgRoutes(deps: {
  principals: PrincipalReader;
  access: OrgAccess;
  orgs: OrgStore;
  workos: WorkosOrgs;
  audit: OrgAudit;
  locks: OrgLocks;
  portal: PortalRevocations;
  now: () => number;
}) {
  const { access, orgs, workos, audit, portal, now } = deps;
  const iso = () => new Date(now()).toISOString();

  /** Runs one membership change of `org`, holding the organization's members lease. */
  async function serialized(org: string, then: () => Promise<Response>): Promise<Response> {
    const held = await deps.locks.holding(`members:${org}`, MEMBERS_LEASE, then);
    return held.ok ? held.value : fail(503, "busy");
  }

  /** The account's membership of `org` as WorkOS holds it now, read inside the turn. */
  async function current(org: string, account: string): Promise<WorkosMembership | undefined> {
    const found = await workos.findMembership(account, org);
    return found && found.organization_id === org && found.user_id === account ? found : undefined;
  }

  /**
   * Whether `member` may change `target`'s membership to `role` (undefined: remove it), on
   * WorkOS's membership and active owners now.
   */
  async function guard(
    member: Member,
    target: WorkosMembership,
    role: string | undefined,
  ): Promise<Response | undefined> {
    if (target.directory_managed === true) return fail(409, "directory_managed");
    const was = orgRole(target.role?.slug ?? "member");
    const touchesOwner = was === "owner" || role === "owner";
    if (touchesOwner && !orgAllows(member.role, "org:owners")) return fail(403, "forbidden");
    const losesOwner = was === "owner" && target.status === "active" && role !== "owner";
    if (losesOwner) {
      const owners = await workos.activeWithRole(member.org, "owner", 2);
      if (!owners.some((each) => each.id !== target.id)) return fail(409, "last_owner");
    }
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

    /**
     * PATCH /v1/orgs/{org}/members/{account}. A role that opens no Admin Portal intent queues the
     * revocation of the account's portal sessions with the mirror's change.
     */
    changeRole: (request: Request, org: string, account: string) =>
      access.member(request, org, "members:manage", async (member) => {
        const body = AceOrgRoleChange.safeParse(await jsonBody(request, 1024));
        if (!body.success) return fail(400, "invalid_request");
        const target = await orgs.member(member.org, account);
        if (!target || target.status === "removed") return fail(404, "not_found");
        const role = body.data.role;
        return serialized(member.org, async () => {
          const found = await current(member.org, account);
          if (!found) return fail(404, "not_found");
          const refused = await guard(member, found, role);
          if (refused) return refused;
          const updated = await workos.updateMembershipRole(found.id, role);
          const after = updated.role?.slug ?? role;
          const revokes = !opensPortal(after);
          await orgs.run([
            orgs.upsertingMember(
              {
                org: member.org,
                account,
                membership: updated.id,
                role: after,
                status: updated.status,
                directoryManaged: updated.directory_managed === true,
                version: updated.updated_at ?? iso(),
              },
              now(),
            ),
            orgs.droppingChecks(member.org, account),
            orgs.flaggingOwners(member.org),
            ...(revokes ? [portal.queueing(member.org, account)] : []),
          ]);
          if (revokes) await portal.revokeNow(member.org, account);
          await audit.record(request, member.org, {
            action: "org.member.role_changed",
            actor: actor(member),
            targets: [{ type: "member", id: account }],
            metadata: { role_before: found.role?.slug ?? "member", role_after: role },
          });
          return json(200, { ok: true });
        });
      }),

    /**
     * DELETE /v1/orgs/{org}/members/{account}: Remove, or Leave for one's own account. Deletes
     * the WorkOS membership and keeps a `removed` row; queues the revocation of the account's
     * Admin Portal sessions, whatever role the mirror showed, and tries it at once.
     */
    remove: (request: Request, org: string, account: string) =>
      access.member(request, org, undefined, async (member) => {
        const self = account === member.principal.account.id;
        if (!self && !orgAllows(member.role, "members:manage")) return fail(403, "forbidden");
        const target = await orgs.member(member.org, account);
        if (!target || target.status === "removed") return fail(404, "not_found");
        return serialized(member.org, async () => {
          const found = await current(member.org, account);
          if (found) {
            // Leaving as the last owner is refused like removing them.
            const refused = await guard(member, found, undefined);
            if (refused) return refused;
            try {
              await workos.deleteMembership(found.id);
            } catch (error) {
              if (error instanceof WorkosRefusal && error.status === 404) {
                // Already gone at WorkOS: mirror that.
              } else if (error instanceof WorkosRefusal && error.status === 422)
                return fail(409, "directory_managed");
              else throw error;
            }
          }
          await orgs.run([
            orgs.removingMember(member.org, account, found?.id ?? target.membership_id, iso()),
            orgs.droppingChecks(member.org, account),
            orgs.flaggingOwners(member.org),
            portal.queueing(member.org, account),
          ]);
          await portal.revokeNow(member.org, account);
          await audit.record(request, member.org, {
            action: "org.member.removed",
            actor: actor(member),
            targets: [{ type: "member", id: account }],
            metadata: { role_before: found?.role?.slug ?? target.role },
          });
          return json(200, { ok: true });
        });
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
        const admin = member.principal.account.id;
        // Never while a revocation of theirs is queued, nor once their membership has changed
        // since WorkOS's answer: a revocation queued after this check runs after the link exists.
        const issued = await portal.link(member.org, admin, body.data.intent, async () => {
          const row = await orgs.member(member.org, admin);
          return (row?.seq ?? null) === member.seq && (!row || row.status === "active");
        });
        if (!issued.ok) return fail(issued.error === "busy" ? 503 : 403, issued.error);
        const { link } = issued;
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
