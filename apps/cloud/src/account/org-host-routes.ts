import {
  AceOrgAuditEntry,
  AceOrgHostEnrollRequest,
  AceOrgId,
  AceOrgPolicySetRequest,
  AceSpace,
} from "@ace/protocol/ace-org";
import { orgRole } from "@ace/account-grant/org-roles";
import { policyBodySha256, signOrgPolicy } from "@ace/account-grant";
import type { GrantSigningKey } from "@ace/account-grant";
import { HostId } from "@ace/relay/wire";
import type { OrgAccess } from "./org-access.ts";
import type { OrgAudit } from "./org-audit.ts";
import type { OrgStore } from "./org-store.ts";
import type { PrincipalReader } from "./principal.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import { WorkosRefusal } from "./workos-orgs.ts";

/** The policy before any version was set: no ceiling of the organization's own. */
const NO_POLICY = "{}";

/**
 * Org hosts, the organization's policy and its hosts' audit forwarding (ADR 0206 §2.1, §3, §4.3),
 * plus `GET /v1/machines?space=`. A machine credential is accepted only where a host speaks for
 * itself: reading its organization's policy and forwarding its own log.
 */
export function orgHostRoutes(deps: {
  principals: PrincipalReader;
  access: OrgAccess;
  orgs: OrgStore;
  audit: OrgAudit;
  signingKey: GrantSigningKey;
  now: () => number;
}) {
  const { access, orgs, audit, now } = deps;

  /** The org host a machine credential belongs to, if it is `org`'s. */
  async function orgHost(request: Request, org: string) {
    const token = bearer(request);
    const principal = token ? await deps.principals.read(token) : undefined;
    if (principal?.kind !== "machine") return undefined;
    return (await orgs.hostOrg(principal.hostId)) === org ? principal : undefined;
  }

  async function currentPolicy(org: string) {
    const stored = await orgs.policy(org);
    return stored
      ? {
          org,
          version: stored.version,
          body: stored.body,
          statement: stored.statement,
          setBy: stored.set_by,
          setAt: stored.set_at,
        }
      : { org, version: 0, body: NO_POLICY };
  }

  return {
    /**
     * GET /v1/machines?space= — `personal`: the account's own machines, never an org host;
     * an org id: that organization's hosts, for an active member.
     */
    async machines(request: Request, space: string): Promise<Response> {
      const parsed = AceSpace.safeParse(space);
      if (!parsed.success) return fail(400, "invalid_request");
      if (parsed.data === "personal") {
        const token = bearer(request);
        const principal = token ? await deps.principals.read(token) : undefined;
        if (!principal) return fail(401, "unauthenticated");
        return json(200, { machines: await orgs.personalMachines(principal.account.id) });
      }
      return access.member(request, parsed.data, undefined, async (member) =>
        json(200, { machines: await orgs.hosts(member.org) }),
      );
    },

    /** GET /v1/orgs/{org}/hosts. */
    hosts: (request: Request, org: string) =>
      access.member(request, org, undefined, async (member) =>
        json(200, { machines: await orgs.hosts(member.org) }),
      ),

    /**
     * POST /v1/orgs/{org}/hosts — a person with `hosts:manage` gives a machine on their own list
     * to the organization. The machine itself also checks the person's standing as its owner.
     */
    enroll: (request: Request, org: string) =>
      access.member(request, org, "hosts:manage", async (member) => {
        const body = AceOrgHostEnrollRequest.safeParse(await jsonBody(request, 1024));
        if (!body.success) return fail(400, "invalid_request");
        const enrolled = await orgs.enrollHost(
          {
            hostId: body.data.hostId,
            org: member.org,
            account: member.principal.account.id,
            auditKey: body.data.auditKey,
          },
          now(),
        );
        if (!enrolled) return fail(409, "not_your_machine");
        await audit.record(request, member.org, {
          action: "org.host.enrolled",
          actor: { type: "member", id: member.principal.account.id },
          targets: [{ type: "host", id: body.data.hostId }],
        });
        return json(201, { ok: true });
      }),

    /** DELETE /v1/orgs/{org}/hosts/{hostId} — an owner releases an org host. */
    release: (request: Request, org: string, hostId: string) =>
      access.member(request, org, undefined, async (member) => {
        if (orgRole(member.role) !== "owner") return fail(403, "forbidden");
        if (!HostId.safeParse(hostId).success) return fail(404, "not_found");
        if (!(await orgs.releaseHost(hostId, member.org))) return fail(404, "not_found");
        await audit.record(request, member.org, {
          action: "org.host.released",
          actor: { type: "member", id: member.principal.account.id },
          targets: [{ type: "host", id: hostId }],
        });
        return json(200, { ok: true });
      }),

    /**
     * GET /v1/orgs/{org}/policy — the current version and the backend's signed statement over
     * its exact text, for a member or one of the organization's hosts.
     */
    async policy(request: Request, org: string): Promise<Response> {
      const id = AceOrgId.safeParse(org);
      if (!id.success) return fail(404, "not_found");
      if (await orgHost(request, id.data)) return json(200, await currentPolicy(id.data));
      return access.member(request, id.data, undefined, async (member) =>
        json(200, await currentPolicy(member.org)),
      );
    },

    /** PUT /v1/orgs/{org}/policy — the next version, signed with the grant key. */
    setPolicy: (request: Request, org: string) =>
      access.member(request, org, "policy:set", async (member) => {
        const parsed = AceOrgPolicySetRequest.safeParse(await jsonBody(request, 65_536));
        if (!parsed.success) return fail(400, "invalid_request");
        const body = JSON.stringify(parsed.data.policy);
        const version = ((await orgs.policy(member.org))?.version ?? 0) + 1;
        const sha256 = policyBodySha256(body);
        const setAt = now();
        const setBy = member.principal.account.id;
        const statement = signOrgPolicy(
          { org: member.org, version, body_sha256: sha256, set_by: setBy, set_at: setAt },
          deps.signingKey,
        );
        const stored = await orgs.putPolicy({
          org: member.org,
          version,
          body,
          sha256,
          setBy,
          setAt,
          statement,
        });
        // Another admin saved this version first: theirs stands, this one is asked again.
        if (!stored) return fail(409, "policy_changed");
        await audit.record(request, member.org, {
          action: "org.policy.changed",
          actor: { type: "member", id: setBy },
          targets: [{ type: "organization", id: member.org }],
          metadata: { version: `${version}`, body_sha256: sha256 },
        });
        return json(200, { org: member.org, version, body, statement, setBy, setAt });
      }),

    /**
     * POST /v1/orgs/{org}/audit — an org host forwards one entry of its log with its machine
     * credential. The entry's hash is WorkOS's idempotency key, so a retry writes it once.
     */
    async forward(request: Request, org: string): Promise<Response> {
      const id = AceOrgId.safeParse(org);
      if (!id.success) return fail(404, "not_found");
      const host = await orgHost(request, id.data);
      if (!host) return fail(403, "not_org_host");
      const entry = AceOrgAuditEntry.safeParse(await jsonBody(request, 32_768));
      if (!entry.success) return fail(400, "invalid_request");
      try {
        await audit.forward(request, id.data, entry.data);
      } catch (error) {
        // WorkOS won't take this entry (its schema refuses it): retrying won't help, so the host
        // keeps it in its own log and moves on.
        if (error instanceof WorkosRefusal) return fail(422, "audit_refused");
        throw error;
      }
      return json(200, { ok: true });
    },
  };
}
