import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

/**
 * WorkOS's organization APIs as ADR 0206 uses them, for the fake WorkOS server: organizations,
 * memberships, invitations, users, Admin Portal links, the Events API (ordered, `after` cursor),
 * Audit Logs (idempotency keys) and the JWKS that signs org-scoped access tokens (RS256).
 */

type Json = Record<string, unknown>;
export type FakeMembership = {
  object: "organization_membership";
  id: string;
  user_id: string;
  organization_id: string;
  status: "active" | "inactive" | "pending";
  role: { slug: string };
  directory_managed: boolean;
  created_at: string;
  updated_at: string;
};
type Invitation = {
  object: "invitation";
  id: string;
  email: string;
  state: string;
  organization_id: string;
  inviter_user_id: string | null;
  role_slug: string;
  token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
const ok = (value: unknown, status = 200) => ({ status, body: value });
const notFound = () => ({ status: 404, body: { message: "Not found" } });
type User = { id: string; email: string; first_name: string; last_name: string | null };

export function fakeWorkosOrgs(clientId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fake-key-1";
  const organizations = new Map<string, { id: string; name: string; updated_at: string }>();
  const memberships = new Map<string, FakeMembership>();
  const invitations = new Map<string, Invitation>();
  const users = new Map<string, User>();
  const events: { object: "event"; id: string; event: string; data: Json; created_at: string }[] =
    [];
  const audits = new Map<string, { org: string; event: Json }>();
  const portalLinks: { organization: string; intent: string; external_user_id: string }[] = [];
  const portalRevocations: { organization: string; external_user_id: string }[] = [];
  /** Organizations whose sign-in policy this session can't meet, with WorkOS's error code. */
  const refusals = new Map<string, string>();
  let ids = 0;
  let clock = 0;
  let eventPages = 0;
  const nextId = (prefix: string) => `${prefix}_01FAKE${String(++ids).padStart(6, "0")}`;
  /** WorkOS's clock: real time, strictly increasing so events order by it. */
  const timestamp = () => {
    clock = Math.max(clock + 1, Date.now());
    return new Date(clock).toISOString();
  };
  const emit = (event: string, data: Json) =>
    events.push({
      object: "event",
      id: nextId("event"),
      event,
      data: { ...data },
      created_at: timestamp(),
    });

  function sign(claims: Json): string {
    const encode = (value: Json) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(claims)}`;
    const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
    return `${input}.${signature}`;
  }

  function addMembership(
    user: string,
    org: string,
    role: string,
    extra: Partial<FakeMembership> = {},
  ) {
    const existing = [...memberships.values()].find(
      (each) => each.user_id === user && each.organization_id === org,
    );
    if (existing) return existing;
    const at = timestamp();
    const membership: FakeMembership = {
      object: "organization_membership",
      id: nextId("om"),
      user_id: user,
      organization_id: org,
      status: "active",
      role: { slug: role },
      directory_managed: false,
      created_at: at,
      updated_at: at,
      ...extra,
    };
    memberships.set(membership.id, membership);
    emit("organization_membership.created", membership);
    return membership;
  }
  function changeMembership(membership: FakeMembership, change: Partial<FakeMembership>) {
    Object.assign(membership, change, { updated_at: timestamp() });
    emit("organization_membership.updated", membership);
  }
  const membershipOf = (user: string, org: string) =>
    [...memberships.values()].find((each) => each.user_id === user && each.organization_id === org);

  /** Answers one org API request, or undefined when it isn't one. */
  function handle(
    method: string,
    url: URL,
    body: Json,
    headers: Record<string, string | string[] | undefined>,
  ): { status: number; body: unknown } | undefined {
    const path = url.pathname;
    let match: RegExpMatchArray | null;
    if (method === "GET" && path === `/sso/jwks/${clientId}`)
      return ok({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }],
      });

    if (method === "POST" && path === "/organizations") {
      const org = {
        object: "organization",
        id: nextId("org"),
        name: String(body.name),
        updated_at: timestamp(),
      };
      organizations.set(org.id, org);
      emit("organization.created", org);
      return ok(org, 201);
    }
    if ((match = path.match(/^\/organizations\/([^/]+)$/))) {
      const org = organizations.get(match[1] ?? "");
      if (!org) return notFound();
      if (method === "GET") return ok({ object: "organization", ...org });
      if (method === "DELETE") {
        organizations.delete(org.id);
        emit("organization.deleted", org);
        return ok({}, 202);
      }
    }
    if (
      method === "PUT" &&
      (match = path.match(/^\/organizations\/([^/]+)\/audit_logs_retention$/))
    )
      return ok({ retention_period_in_days: body.retention_period === "1_YEAR" ? 365 : 30 });

    if (path === "/user_management/organization_memberships") {
      if (method === "POST") {
        const membership = addMembership(
          String(body.user_id),
          String(body.organization_id),
          String(body.role_slug ?? "member"),
        );
        return ok(membership, 201);
      }
      if (method === "GET") {
        const statuses = url.searchParams.getAll("statuses");
        const data = [...memberships.values()].filter(
          (each) =>
            (!url.searchParams.has("user_id") ||
              each.user_id === url.searchParams.get("user_id")) &&
            (!url.searchParams.has("organization_id") ||
              each.organization_id === url.searchParams.get("organization_id")) &&
            (statuses.length === 0 ? each.status === "active" : statuses.includes(each.status)),
        );
        return ok({ object: "list", data, list_metadata: { before: null, after: null } });
      }
    }
    if ((match = path.match(/^\/user_management\/organization_memberships\/([^/]+)$/))) {
      const membership = memberships.get(match[1] ?? "");
      if (!membership) return notFound();
      if (method === "GET") return ok(membership);
      if (method === "PUT") {
        changeMembership(membership, { role: { slug: String(body.role_slug) } });
        return ok(membership);
      }
      if (method === "DELETE") {
        if (membership.directory_managed)
          return { status: 422, body: { code: "organization_membership_directory_managed" } };
        memberships.delete(membership.id);
        emit("organization_membership.deleted", { ...membership, updated_at: timestamp() });
        return ok({}, 202);
      }
    }

    if (path === "/user_management/invitations") {
      if (method === "POST") {
        const at = timestamp();
        const invitation: Invitation = {
          object: "invitation",
          id: nextId("invitation"),
          email: String(body.email),
          state: "pending",
          organization_id: String(body.organization_id),
          inviter_user_id: typeof body.inviter_user_id === "string" ? body.inviter_user_id : null,
          role_slug: String(body.role_slug ?? "member"),
          token: randomUUID().replaceAll("-", ""),
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          created_at: at,
          updated_at: at,
        };
        invitations.set(invitation.id, invitation);
        return ok(invitation, 201);
      }
      if (method === "GET") {
        const org = url.searchParams.get("organization_id");
        const data = [...invitations.values()].filter(
          (each) => !org || each.organization_id === org,
        );
        return ok({ object: "list", data, list_metadata: { before: null, after: null } });
      }
    }
    if (
      method === "GET" &&
      (match = path.match(/^\/user_management\/invitations\/by_token\/([^/]+)$/))
    ) {
      const found = [...invitations.values()].find((each) => each.token === match?.[1]);
      return found ? ok(found) : notFound();
    }
    if ((match = path.match(/^\/user_management\/invitations\/([^/]+)(\/revoke)?$/))) {
      const found = invitations.get(match[1] ?? "");
      if (!found) return notFound();
      if (method === "GET" && !match[2]) return ok(found);
      if (method === "POST" && match[2]) {
        found.state = "revoked";
        return ok(found);
      }
    }
    if (method === "GET" && (match = path.match(/^\/user_management\/users\/([^/]+)$/))) {
      const user = users.get(match[1] ?? "");
      return user ? ok({ object: "user", ...user }) : notFound();
    }

    if (method === "POST" && path === "/portal/generate_link") {
      portalLinks.push({
        organization: String(body.organization),
        intent: String(body.intent),
        external_user_id: String(body.external_user_id),
      });
      return ok({ link: `https://setup.workos.test/portal?token=${portalLinks.length}` });
    }
    if (method === "POST" && path === "/portal/revoke_link") {
      portalRevocations.push({
        organization: String(body.organization),
        external_user_id: String(body.external_user_id),
      });
      return ok({});
    }

    if (method === "GET" && path === "/events") {
      eventPages++;
      const wanted = new Set((url.searchParams.get("events") ?? "").split(","));
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const start = after ? events.findIndex((each) => each.id === after) + 1 : 0;
      const data = events
        .slice(start)
        .filter((each) => wanted.has(each.event))
        .slice(0, limit);
      return ok({ object: "list", data, list_metadata: { after: data.at(-1)?.id ?? null } });
    }
    if (method === "POST" && path === "/audit_logs/events") {
      const key = String(headers["idempotency-key"] ?? randomUUID());
      if (!audits.has(key))
        audits.set(key, { org: String(body.organization_id), event: body.event as Json });
      return ok({ success: true }, 201);
    }
    return undefined;
  }

  return {
    handle,
    /** A person who signed in is a WorkOS user the org APIs can name. */
    knowUser: (user: User) => users.set(user.id, user),
    /**
     * A refresh into `org`: an access token naming the membership, or WorkOS's refusal for a
     * session that isn't an active member or that the organization's sign-in policy turns away.
     */
    refreshInto(
      user: string,
      org: string,
    ): { status: number; body: Json } | { accessToken: string } {
      const refused = refusals.get(org);
      if (refused)
        return { status: 403, body: { error: refused, error_description: "Sign-in policy" } };
      const membership = membershipOf(user, org);
      if (membership?.status !== "active")
        return {
          status: 403,
          body: { code: "organization_membership_not_found", message: "Not a member" },
        };
      const now = Math.floor(Date.now() / 1000);
      return {
        accessToken: sign({
          iss: "https://api.workos.com",
          sub: user,
          sid: `session_${user}`,
          org_id: org,
          role: membership.role.slug,
          permissions: ["widget:everything"],
          iat: now,
          exp: now + 300,
        }),
      };
    },
    /** Signing in with an invitation's token accepts it: the membership WorkOS makes. */
    acceptInvitation(token: string, user: string): string | undefined {
      const found = [...invitations.values()].find((each) => each.token === token);
      if (!found || found.state !== "pending") return undefined;
      found.state = "accepted";
      addMembership(user, found.organization_id, found.role_slug);
      return found.organization_id;
    },
    /** As the WorkOS dashboard or a directory would. */
    addMember: (user: string, org: string, role = "member", extra: Partial<FakeMembership> = {}) =>
      addMembership(user, org, role, extra),
    setRole(user: string, org: string, role: string) {
      const membership = membershipOf(user, org);
      if (membership) changeMembership(membership, { role: { slug: role } });
    },
    deactivate(user: string, org: string) {
      const membership = membershipOf(user, org);
      if (membership) changeMembership(membership, { status: "inactive" });
    },
    refuseOrg: (org: string, code: string | undefined) =>
      code ? refusals.set(org, code) : refusals.delete(org),
    membership: membershipOf,
    invitations: () => [...invitations.values()],
    events: () => events,
    eventPages: () => eventPages,
    audits: () => [...audits.values()],
    portalLinks: () => portalLinks,
    portalRevocations: () => portalRevocations,
  };
}
export type FakeWorkosOrgs = ReturnType<typeof fakeWorkosOrgs>;
