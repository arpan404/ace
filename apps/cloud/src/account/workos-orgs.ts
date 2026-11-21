import { z } from "zod";
import type { AccountConfig } from "./config.ts";

/**
 * WorkOS's organization APIs over REST, as ADR 0206 uses them: organizations, memberships,
 * invitations, users, Admin Portal links, the Events API and Audit Logs. Answers are decoded
 * leniently: unknown fields are ignored and unknown values kept as given.
 */

/** WorkOS answered with a client error; `code` is its error code when it gave one. */
export class WorkosRefusal extends Error {
  override name = "WorkosRefusal";
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super(`WorkOS refused (${status}${code ? ` ${code}` : ""})`);
    this.status = status;
    this.code = code;
  }
}

export const WorkosOrganization = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().max(256),
  updated_at: z.string().max(64).optional(),
});
export type WorkosOrganization = z.infer<typeof WorkosOrganization>;

export const WorkosMembership = z.looseObject({
  id: z.string().min(1).max(128),
  user_id: z.string().min(1).max(256),
  organization_id: z.string().min(1).max(128),
  status: z.string().max(32),
  role: z.looseObject({ slug: z.string().max(64) }).nullish(),
  directory_managed: z.boolean().nullish(),
  updated_at: z.string().max(64).optional(),
  user: z
    .looseObject({
      email: z.string().max(320).nullish(),
      first_name: z.string().max(128).nullish(),
      last_name: z.string().max(128).nullish(),
    })
    .nullish(),
});
export type WorkosMembership = z.infer<typeof WorkosMembership>;

export const WorkosInvitation = z.looseObject({
  id: z.string().min(1).max(128),
  email: z.string().max(320),
  state: z.string().max(32),
  organization_id: z.string().max(128).nullish(),
  inviter_user_id: z.string().max(256).nullish(),
  role_slug: z.string().max(64).nullish(),
  expires_at: z.string().max(64),
});
export type WorkosInvitation = z.infer<typeof WorkosInvitation>;

export const WorkosUser = z.looseObject({
  id: z.string().min(1).max(256),
  email: z.string().max(320),
  first_name: z.string().max(128).nullish(),
  last_name: z.string().max(128).nullish(),
});

export const WorkosEvent = z.looseObject({
  id: z.string().min(1).max(128),
  event: z.string().max(128),
  data: z.unknown(),
  created_at: z.string().max(64),
});
export type WorkosEvent = z.infer<typeof WorkosEvent>;
const EventPage = z.looseObject({
  data: z.array(z.unknown()).max(100),
  list_metadata: z.looseObject({ after: z.string().nullish() }).nullish(),
});

/** The events the members mirror follows (ADR 0206 §1.1). */
export const MIRRORED_EVENTS = [
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "user.updated",
] as const;

const Failure = z.looseObject({ code: z.string().optional(), error: z.string().optional() });
const list = <Item extends z.ZodType>(item: Item) =>
  z.looseObject({ data: z.array(z.unknown()).max(100) }).transform((page) =>
    page.data.flatMap((raw) => {
      const parsed = item.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    }),
  );

const MembershipList = list(WorkosMembership);
const InvitationList = list(WorkosInvitation);
const PortalLink = z.looseObject({ link: z.url() });
const EventId = WorkosEvent.pick({ id: true });

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("WorkOS answered an unexpected shape");
  return parsed.data;
}
const id = (value: string) => encodeURIComponent(value);

export function workosOrgs(config: AccountConfig, fetcher: typeof fetch) {
  const base = config.workosUrl;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const raw: unknown = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (response.status >= 400 && response.status < 500) {
      const failure = Failure.safeParse(raw);
      const code = failure.success ? (failure.data.code ?? failure.data.error) : undefined;
      console.warn(
        JSON.stringify({ event: "workos_refused", method, status: response.status, code }),
      );
      throw new WorkosRefusal(response.status, code);
    }
    if (!response.ok) throw new Error(`WorkOS answered ${response.status}`);
    return raw;
  }

  return {
    createOrganization: async (name: string) =>
      parse(WorkosOrganization, await call("POST", "/organizations", { name })),
    getOrganization: async (org: string) =>
      parse(WorkosOrganization, await call("GET", `/organizations/${id(org)}`)),
    deleteOrganization: async (org: string) => {
      await call("DELETE", `/organizations/${id(org)}`);
    },
    /** Audit Logs retention, which WorkOS only lets grow (ADR 0206 §4.3). */
    setAuditRetention: async (org: string, period: string) => {
      await call("PUT", `/organizations/${id(org)}/audit_logs_retention`, {
        retention_period: period,
      });
    },

    createMembership: async (user: string, org: string, role: string) =>
      parse(
        WorkosMembership,
        await call("POST", "/user_management/organization_memberships", {
          user_id: user,
          organization_id: org,
          role_slug: role,
        }),
      ),
    /** The account's membership of the organization in any status, if there is one. */
    async findMembership(user: string, org: string): Promise<WorkosMembership | undefined> {
      const query = new URLSearchParams({ user_id: user, organization_id: org, limit: "10" });
      for (const status of ["active", "inactive", "pending"]) query.append("statuses", status);
      const found = parse(
        MembershipList,
        await call("GET", `/user_management/organization_memberships?${query}`),
      );
      return found[0];
    },
    updateMembershipRole: async (membership: string, role: string) =>
      parse(
        WorkosMembership,
        await call("PUT", `/user_management/organization_memberships/${id(membership)}`, {
          role_slug: role,
        }),
      ),
    /**
     * Deletes a membership. ace's Remove deletes, never deactivates: deactivating revokes every
     * WorkOS session of the person, personal ones too (ADR 0206 §6).
     */
    deleteMembership: async (membership: string) => {
      await call("DELETE", `/user_management/organization_memberships/${id(membership)}`);
    },

    sendInvitation: async (invite: { email: string; org: string; role: string; inviter: string }) =>
      parse(
        WorkosInvitation,
        await call("POST", "/user_management/invitations", {
          email: invite.email,
          organization_id: invite.org,
          role_slug: invite.role,
          inviter_user_id: invite.inviter,
          expires_in_days: 7,
        }),
      ),
    listInvitations: async (org: string) =>
      parse(
        InvitationList,
        await call(
          "GET",
          `/user_management/invitations?${new URLSearchParams({ organization_id: org, limit: "100" })}`,
        ),
      ),
    getInvitation: async (invitation: string) =>
      parse(WorkosInvitation, await call("GET", `/user_management/invitations/${id(invitation)}`)),
    findInvitation: async (token: string) =>
      parse(
        WorkosInvitation,
        await call("GET", `/user_management/invitations/by_token/${id(token)}`),
      ),
    revokeInvitation: async (invitation: string) => {
      await call("POST", `/user_management/invitations/${id(invitation)}/revoke`);
    },

    getUser: async (user: string) =>
      parse(WorkosUser, await call("GET", `/user_management/users/${id(user)}`)),

    /** A five-minute Admin Portal link, tagged with the admin's account so it can be revoked. */
    portalLink: async (org: string, intent: string, admin: string) =>
      parse(
        PortalLink,
        await call("POST", "/portal/generate_link", {
          organization: org,
          intent,
          external_user_id: admin,
        }),
      ).link,
    /** Ends every Admin Portal link and session this admin opened for the organization. */
    revokePortal: async (org: string, admin: string) => {
      await call("POST", "/portal/revoke_link", { organization: org, external_user_id: admin });
    },

    /** One page of the Events API after `after`, oldest first, and the cursor it ends at. */
    async events(after: string | undefined, limit: number) {
      const query = new URLSearchParams({ events: MIRRORED_EVENTS.join(","), limit: `${limit}` });
      if (after) query.set("after", after);
      const page = parse(EventPage, await call("GET", `/events?${query}`));
      const events: WorkosEvent[] = [];
      // An event ace can't read is kept in the count (so the cursor moves past it), not applied.
      for (const raw of page.data) {
        const parsed = WorkosEvent.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
      }
      const last = page.data.at(-1);
      const lastId = EventId.safeParse(last);
      return {
        events,
        count: page.data.length,
        after: lastId.success ? lastId.data.id : (page.list_metadata?.after ?? after),
      };
    },

    /** Writes one Audit Logs event; `idempotencyKey` makes a retry write nothing more. */
    createAuditEvent: async (org: string, event: unknown, idempotencyKey: string) => {
      await call(
        "POST",
        "/audit_logs/events",
        { organization_id: org, event },
        { "Idempotency-Key": idempotencyKey },
      );
    },
  };
}
export type WorkosOrgs = ReturnType<typeof workosOrgs>;
