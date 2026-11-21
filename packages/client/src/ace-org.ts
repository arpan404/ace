import { AceAccountOrigin, AceMachineList, type AceMachine } from "@ace/protocol/ace-account";
import {
  AceOrgAssignableRole,
  AceOrgId,
  AceOrgInvitation,
  AceOrgInvitationList,
  AceOrgList,
  AceOrgMemberList,
  AceOrgPolicyVersion,
  AceOrgPortalLink,
  AceOrgSpace,
  AceSpace,
  type AceOrgHostEnrollRequest,
  type AceOrgInvitation as Invitation,
  type AceOrgMember,
  type AceOrgPolicy,
  type AceOrgPortalIntent,
  type AceOrgSpace as Space,
} from "@ace/protocol/ace-org";
import { z } from "zod";
import { AceAccountError } from "./ace-account.ts";
import { httpJson } from "./http-json.ts";

/** What the backend said when it refused an org call: `{error, org?}`, when it said anything. */
const Refusal = z.object({ error: z.string().max(64), org: AceOrgId.optional() });

/**
 * An org route refused (ADR 0206): the backend's `error` word (`forbidden`, `last_owner`,
 * `directory_managed`, `org_sign_in_required`, …) beside the status. A 401 is still an ended
 * session, as for every account call.
 */
export class AceOrgError extends AceAccountError {
  readonly code: string;
  /** For `org_sign_in_required`: the organization whose sign-in policy wants a new sign-in. */
  readonly org: string | undefined;
  constructor(status: number, code: string, org?: string) {
    super(status);
    this.code = code;
    this.org = org;
  }
}

const segment = (value: string) => encodeURIComponent(value);
/** An organization's routes: `orgs/{id}`, the id checked first. */
const org = (id: string) => `orgs/${AceOrgId.parse(id)}`;

/**
 * Organizations on the account backend (ADR 0206 §1, §2.7): the person's spaces, an
 * organization's members, invitations, Admin Portal links, hosts and policy. Every call is the
 * person's own session; WorkOS decides membership on the backend.
 */
export function aceOrgClient(options: { origin: string; fetch: typeof fetch }) {
  const origin = AceAccountOrigin.parse(options.origin);
  async function call(
    path: string,
    method: string,
    token: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = {
      method,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    } as const;
    const response = await options.fetch(`${origin}/v1/${path}`, init);
    if (!response.ok) {
      const said = Refusal.safeParse(await httpJson(response, 4096).catch(() => undefined));
      throw new AceOrgError(
        response.status,
        said.success ? said.data.error : "unavailable",
        said.success ? said.data.org : undefined,
      );
    }
    return httpJson(response, 256 * 1024);
  }
  return {
    /** The person's organizations, for the space switcher (the mirror's active memberships). */
    async spaces(token: string, signal: AbortSignal): Promise<Space[]> {
      return AceOrgList.parse(await call("orgs", "GET", token, signal)).orgs;
    },
    /** A new organization with the person as its owner; needs a verified email. */
    async create(token: string, name: string, signal: AbortSignal): Promise<Space> {
      return AceOrgSpace.parse(await call("orgs", "POST", token, signal, { name }));
    },
    /** Machines in one space: the person's own, or an organization's hosts. */
    async machines(token: string, space: string, signal: AbortSignal): Promise<AceMachine[]> {
      const query = new URLSearchParams({ space: AceSpace.parse(space) });
      return AceMachineList.parse(await call(`machines?${query}`, "GET", token, signal)).machines;
    },
    async members(token: string, id: string, signal: AbortSignal): Promise<AceOrgMember[]> {
      return AceOrgMemberList.parse(await call(`${org(id)}/members`, "GET", token, signal)).members;
    },
    async changeRole(
      token: string,
      id: string,
      account: string,
      role: AceOrgAssignableRole,
      signal: AbortSignal,
    ): Promise<void> {
      await call(`${org(id)}/members/${segment(account)}`, "PATCH", token, signal, {
        role: AceOrgAssignableRole.parse(role),
      });
    },
    /** Remove, or Leave for the person's own account: deletes the membership, nothing else. */
    async removeMember(token: string, id: string, account: string, signal: AbortSignal) {
      await call(`${org(id)}/members/${segment(account)}`, "DELETE", token, signal);
    },
    async invitations(token: string, id: string, signal: AbortSignal): Promise<Invitation[]> {
      return AceOrgInvitationList.parse(await call(`${org(id)}/invitations`, "GET", token, signal))
        .invitations;
    },
    /** WorkOS sends the mail; its link opens ace's join page. */
    async invite(
      token: string,
      id: string,
      invitation: { email: string; role: AceOrgAssignableRole },
      signal: AbortSignal,
    ): Promise<Invitation> {
      return AceOrgInvitation.parse(
        await call(`${org(id)}/invitations`, "POST", token, signal, invitation),
      );
    },
    async revokeInvitation(token: string, id: string, invitation: string, signal: AbortSignal) {
      await call(`${org(id)}/invitations/${segment(invitation)}`, "DELETE", token, signal);
    },
    /** A five-minute Admin Portal link for one setup task, tagged with the admin's account. */
    async portal(token: string, id: string, intent: AceOrgPortalIntent, signal: AbortSignal) {
      return AceOrgPortalLink.parse(
        await call(`${org(id)}/portal`, "POST", token, signal, { intent }),
      );
    },
    async hosts(token: string, id: string, signal: AbortSignal): Promise<AceMachine[]> {
      return AceMachineList.parse(await call(`${org(id)}/hosts`, "GET", token, signal)).machines;
    },
    /** Gives a machine to the organization with that machine's own consent (`account.owner.enroll`). */
    async enrollHost(
      token: string,
      id: string,
      request: AceOrgHostEnrollRequest,
      signal: AbortSignal,
    ): Promise<void> {
      await call(`${org(id)}/hosts`, "POST", token, signal, request);
    },
    /** An owner releases a host: its credentials from this enrollment stop working. */
    async releaseHost(token: string, id: string, hostId: string, signal: AbortSignal) {
      await call(`${org(id)}/hosts/${segment(hostId)}`, "DELETE", token, signal);
    },
    async policy(token: string, id: string, signal: AbortSignal) {
      return AceOrgPolicyVersion.parse(await call(`${org(id)}/policy`, "GET", token, signal));
    },
    /** Saves the next version; `policy_changed` when another admin saved one first. */
    async setPolicy(token: string, id: string, policy: AceOrgPolicy, signal: AbortSignal) {
      return AceOrgPolicyVersion.parse(
        await call(`${org(id)}/policy`, "PUT", token, signal, { policy }),
      );
    },
  };
}
export type AceOrgClient = ReturnType<typeof aceOrgClient>;

/** What each role may do in ace (ADR 0206 §1.2): the backend's and the daemon's own table. */
export { orgAllows, orgRole, type OrgPermission } from "@ace/account-grant/org-roles";
