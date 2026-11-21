/*
 * Organizations on the fake ace account (ADR 0206), in memory: `?fakeWorld=org` makes the fake
 * person the owner of Acme Robotics, whose host is the build server, and a member of Night Shift
 * Labs; every other world starts with none. The backend's routes as `aceOrgClient` calls them,
 * with its refusals (`last_owner`, `forbidden`), so the pages show what the real one says.
 */
import type {
  AceOrgInvitation,
  AceOrgMember,
  AceOrgPolicy,
  AceOrgSpace,
} from "@ace/protocol/ace-org";
import type { AceMachine } from "@ace/protocol/ace-account";
import { z } from "zod";

/** The build server's relay id in the org world: one of Acme Robotics' hosts. */
export const fakeOrgHostId = "BUILDSERVERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const fakeOrgs = { acme: "org_01ACMEROBOTICS", night: "org_01NIGHTSHIFT" };

const json = (status: number, body: unknown) => Response.json(body, { status });
const fail = (status: number, error: string) => json(status, { error });
const Body = z.record(z.string(), z.unknown());
const read = async (init: RequestInit | undefined) => {
  try {
    return Body.parse(JSON.parse(String(init?.body)));
  } catch {
    return {};
  }
};

interface FakeOrg {
  space: AceOrgSpace;
  members: AceOrgMember[];
  invitations: AceOrgInvitation[];
  hosts: AceMachine[];
  policy: { version: number; body: string; setBy?: string; setAt?: number };
}

/** Acme Robotics' policy as an admin left it: version 3. */
const acmePolicy: AceOrgPolicy = {
  effects: { pay: "off", send_as_person: "approvers", publish: "admins" },
  full_access: "never",
  commands_outside_sandbox: "admins",
  members_create_bots: true,
  packages: {
    sources: { market: true, registry: true, git: false },
    mode: "allowlist",
    allow: [
      { source: "market", name: "spade-bot/ci-watcher" },
      { source: "registry", name: "*" },
    ],
  },
  models: { endpoints: ["openrouter.ai"], local: true, subscriptions: false },
  audit: { content: "digests" },
};

function seeded(person: { id: string; email: string; name: string }, now: () => number) {
  const acme: FakeOrg = {
    space: {
      id: fakeOrgs.acme,
      name: "Acme Robotics",
      role: "owner",
      plan: "pilot",
      directoryManaged: false,
    },
    members: [
      {
        account: person.id,
        email: person.email,
        name: person.name,
        role: "owner",
        status: "active",
        directoryManaged: false,
      },
      {
        account: "user_dana",
        email: "dana@acme.dev",
        name: "Dana Kim",
        role: "admin",
        status: "active",
        directoryManaged: false,
      },
      {
        account: "user_lee",
        email: "lee@acme.dev",
        name: "Lee Park",
        role: "member",
        status: "active",
        directoryManaged: true,
      },
      {
        account: "user_sam",
        email: "sam@acme.dev",
        name: "Sam Wu",
        role: "member",
        status: "active",
        directoryManaged: false,
      },
    ],
    invitations: [
      {
        id: "invitation_jordan",
        email: "jordan@acme.dev",
        role: "member",
        state: "pending",
        expiresAt: new Date(now() + 6 * 86_400_000).toISOString(),
      },
    ],
    hosts: [
      {
        hostId: fakeOrgHostId,
        name: "Build server",
        platform: "linux",
        lastSeenAt: now() - 60_000,
      },
    ],
    policy: {
      version: 3,
      body: JSON.stringify(acmePolicy),
      setBy: "user_dana",
      setAt: now() - 2 * 86_400_000,
    },
  };
  const night: FakeOrg = {
    space: {
      id: fakeOrgs.night,
      name: "Night Shift Labs",
      role: "member",
      plan: "pilot",
      directoryManaged: false,
    },
    members: [
      {
        account: "user_ava",
        email: "ava@nightshift.dev",
        name: "Ava Lin",
        role: "owner",
        status: "active",
        directoryManaged: false,
      },
      {
        account: person.id,
        email: person.email,
        name: person.name,
        role: "member",
        status: "active",
        directoryManaged: false,
      },
    ],
    invitations: [],
    hosts: [],
    policy: { version: 0, body: "{}" },
  };
  return [acme, night];
}

/**
 * The fake backend's org routes. `personal` is the person's own machine list, answered for
 * `GET /v1/machines` and `?space=personal`. Answers undefined for any other path.
 */
export function fakeOrgRoutes(options: {
  person: { id: string; email: string; name: string };
  now: () => number;
  personal: () => AceMachine[];
  world: string | null;
}) {
  const { person, now } = options;
  let made = 0;
  const orgs: FakeOrg[] = options.world === "org" ? seeded(person, now) : [];
  const find = (id: string) => orgs.find((org) => org.space.id === id);
  const admin = (org: FakeOrg) => org.space.role === "owner" || org.space.role === "admin";
  return async (url: URL, init: RequestInit | undefined): Promise<Response | undefined> => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/machines" && method === "GET") {
      const space = url.searchParams.get("space");
      if (space === null || space === "personal")
        return json(200, { machines: options.personal() });
      const org = find(space);
      return org ? json(200, { machines: org.hosts }) : fail(403, "not_member");
    }
    if (path === "/v1/orgs" && method === "GET")
      return json(200, { orgs: orgs.map((org) => org.space) });
    if (path === "/v1/orgs" && method === "POST") {
      const name = String((await read(init)).name ?? "").trim();
      if (!name) return fail(400, "invalid_request");
      const space: AceOrgSpace = {
        id: `org_01MADE${++made}`,
        name,
        role: "owner",
        plan: "pilot",
        directoryManaged: false,
      };
      orgs.push({
        space,
        members: [
          {
            account: person.id,
            email: person.email,
            name: person.name,
            role: "owner",
            status: "active",
            directoryManaged: false,
          },
        ],
        invitations: [],
        hosts: [],
        policy: { version: 0, body: "{}" },
      });
      return json(201, space);
    }
    const match = path.match(/^\/v1\/orgs\/(org_[A-Za-z0-9]+)\/([a-z-]+)(?:\/([^/]+))?$/);
    if (!match) return undefined;
    const [, id = "", what, part] = match;
    const org = find(id);
    if (!org) return fail(403, "not_member");
    const target = part ? decodeURIComponent(part) : undefined;
    if (what === "members" && method === "GET")
      return json(200, { members: org.members.filter((m) => m.status !== "removed") });
    if (what === "members" && target && method === "PATCH") {
      if (!admin(org)) return fail(403, "forbidden");
      const member = org.members.find((m) => m.account === target);
      if (!member) return fail(404, "not_found");
      if (member.directoryManaged) return fail(409, "directory_managed");
      const role = String((await read(init)).role ?? "");
      const owners = org.members.filter((m) => m.role === "owner" && m.status === "active");
      if (member.role === "owner" && role !== "owner" && owners.length < 2)
        return fail(409, "last_owner");
      member.role = role;
      return json(200, { ok: true });
    }
    if (what === "members" && target && method === "DELETE") {
      const self = target === person.id;
      if (!self && !admin(org)) return fail(403, "forbidden");
      const member = org.members.find((m) => m.account === target);
      if (!member) return fail(404, "not_found");
      const owners = org.members.filter((m) => m.role === "owner" && m.status === "active");
      if (member.role === "owner" && owners.length < 2) return fail(409, "last_owner");
      org.members = org.members.filter((m) => m !== member);
      // Leaving: the space goes from the list; nothing else of the person's changes.
      if (self) orgs.splice(orgs.indexOf(org), 1);
      return json(200, { ok: true });
    }
    if (what === "invitations" && method === "GET")
      return admin(org) ? json(200, { invitations: org.invitations }) : fail(403, "forbidden");
    if (what === "invitations" && method === "POST") {
      if (!admin(org)) return fail(403, "forbidden");
      const body = await read(init);
      const invitation: AceOrgInvitation = {
        id: `invitation_${org.invitations.length + 1}`,
        email: String(body.email ?? ""),
        role: String(body.role ?? "member"),
        state: "pending",
        expiresAt: new Date(now() + 7 * 86_400_000).toISOString(),
      };
      org.invitations.push(invitation);
      return json(201, invitation);
    }
    if (what === "invitations" && target && method === "DELETE") {
      org.invitations = org.invitations.filter((each) => each.id !== target);
      return json(200, { ok: true });
    }
    if (what === "portal" && method === "POST") {
      if (!admin(org)) return fail(403, "forbidden");
      const intent = String((await read(init)).intent ?? "sso");
      return json(200, {
        link: `https://setup.workos.com/portal/fake?intent=${intent}`,
        expiresAt: now() + 300_000,
      });
    }
    if (what === "hosts" && method === "GET") return json(200, { machines: org.hosts });
    if (what === "hosts" && target && method === "DELETE") {
      if (org.space.role !== "owner") return fail(403, "forbidden");
      org.hosts = org.hosts.filter((host) => host.hostId !== target);
      return json(200, { ok: true });
    }
    if (what === "policy" && method === "GET")
      return json(200, { org: org.space.id, ...org.policy });
    if (what === "policy" && method === "PUT") {
      if (!admin(org)) return fail(403, "forbidden");
      org.policy = {
        version: org.policy.version + 1,
        body: JSON.stringify((await read(init)).policy ?? {}),
        setBy: person.id,
        setAt: now(),
      };
      return json(200, { org: org.space.id, ...org.policy });
    }
    return fail(404, "not_found");
  };
}
