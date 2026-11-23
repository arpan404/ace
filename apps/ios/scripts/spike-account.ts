/**
 * The ace account backend the phone's `--spike-account` launch signs in to, served on the spike
 * fixture's own port: the session, the account's machines, Forget, Sign out and Delete account, as
 * `packages/client/src/ace-account.ts` names them. It logs each Forget, Sign out and Delete it receives
 * (`GET /account/requests`) so a UI test can check that a cancelled question sent nothing and a
 * confirmed one sent exactly one request; `POST /account/reset` starts a test afresh. An
 * organization's admin routes are `spike-account-org.ts`.
 */

import { SpikeOrgAdmin, type OrgLogged } from "./spike-account-org.ts";

/** The session token the app's `--spike-account` launch presents. */
export const spikeAccountToken = "ios-spike-account-session";

/** The account's two machines, as 52-character host ids the phone accepts. */
export const spikeAccountMachineIds = {
  laptop: "L".repeat(52),
  studio: "S".repeat(52),
};

type Logged =
  | { kind: "forget"; hostId: string }
  | { kind: "signOut" }
  | { kind: "delete" }
  | { kind: "createOrg"; name: string }
  | { kind: "leave"; org: string }
  | ({ org: string } & OrgLogged);
interface Org {
  id: string;
  name: string;
  role: string;
  plan: "team" | "pilot";
  directoryManaged: boolean;
  hosts: string[];
  admin: SpikeOrgAdmin;
}
interface Machine {
  hostId: string;
  name: string;
  platform: string;
  lastSeenAt: number;
}

/** An organization as `GET /v1/orgs` lists it, without the fixture's own host list. */
const view = (org: Org) => ({
  id: org.id,
  name: org.name,
  role: org.role,
  plan: org.plan,
  directoryManaged: org.directoryManaged,
});

const account = { id: "acct_spike", email: "ada@example.com", name: "Ada Lovelace" };
const minute = 60_000;
const day = 86_400_000;

export class SpikeAccount {
  private machines: Machine[] = [];
  /** The person's organizations (ADR 0206 §1.4); none unless `ACE_IOS_SPIKE_ORG_HOSTS` names Acme's. */
  private orgs: Org[] = [];
  private signedIn = true;
  private log: Logged[] = [];

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
    this.reset();
  }

  /** The reply for an account path, or undefined for the rest of the fixture. */
  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === "/account/requests") return Response.json({ requests: this.log });
    if (path === "/account/reset" && request.method === "POST") {
      this.reset();
      return Response.json({});
    }
    const owned =
      path === "/v1/account" ||
      path.startsWith("/v1/account/session") ||
      path.startsWith("/v1/machines") ||
      path.startsWith("/v1/orgs");
    if (!owned) return;
    const authorized =
      this.signedIn && request.headers.get("authorization") === `Bearer ${spikeAccountToken}`;
    if (!authorized) return Response.json({}, { status: 401 });
    if (path === "/v1/account" && request.method === "DELETE") {
      this.log.push({ kind: "delete" });
      this.signedIn = false;
      return Response.json({ deleted: true });
    }
    if (path === "/v1/account/session") {
      if (request.method === "DELETE") {
        this.log.push({ kind: "signOut" });
        this.signedIn = false;
        return Response.json({});
      }
      return Response.json({ account, expiresAt: this.now() + day });
    }
    if (path === "/v1/machines" && request.method === "GET")
      return Response.json({ machines: this.machines });
    const orgs = await this.orgRoutes(request, path);
    if (orgs) return orgs;
    const forget = /^\/v1\/machines\/([A-Z2-7]{52})$/.exec(path)?.[1];
    if (forget && request.method === "DELETE") {
      this.log.push({ kind: "forget", hostId: forget });
      this.machines = this.machines.filter((machine) => machine.hostId !== forget);
      return Response.json({});
    }
    return Response.json({}, { status: 404 });
  }

  /** `/v1/orgs…`: the list, a new one, an organization's hosts and members, and Leave. */
  private async orgRoutes(request: Request, path: string): Promise<Response | undefined> {
    if (path === "/v1/orgs" && request.method === "GET")
      return Response.json({ orgs: this.orgs.map(view) });
    if (path === "/v1/orgs" && request.method === "POST") {
      const { name } = (await request.json()) as { name: string };
      const id = `org_new${this.orgs.length}`;
      const org: Org = {
        id,
        name,
        role: "owner",
        plan: "team",
        directoryManaged: false,
        hosts: [],
        admin: this.admin(id, "owner"),
      };
      this.log.push({ kind: "createOrg", name });
      this.orgs.push(org);
      return Response.json(view(org));
    }
    const [, id, part, member] = /^\/v1\/orgs\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path) ?? [];
    const org = this.orgs.find((each) => each.id === id);
    if (!id) return;
    if (!org) return Response.json({ error: "not_member" }, { status: 403 });
    if (part === "hosts" && request.method === "GET")
      return Response.json({
        machines: org.hosts.map((hostId) => ({
          hostId,
          name: "acme-build",
          platform: "linux",
          lastSeenAt: this.now(),
        })),
      });
    if (part === "members" && member === account.id && request.method === "DELETE") {
      this.log.push({ kind: "leave", org: org.id });
      this.orgs = this.orgs.filter((each) => each.id !== org.id);
      return Response.json({});
    }
    if (part === "hosts" && member && request.method === "DELETE") {
      this.log.push({ org: org.id, kind: "release", hostId: member });
      org.hosts = org.hosts.filter((hostId) => hostId !== member);
      return Response.json({});
    }
    const answered = await org.admin.route(request, part ?? "", member);
    return answered ?? Response.json({ error: "not_found" }, { status: 404 });
  }

  private admin(org: string, role: string): SpikeOrgAdmin {
    return new SpikeOrgAdmin(
      org,
      { account: account.id, email: account.email, name: account.name, role },
      (entry) => this.log.push({ org, ...entry }),
    );
  }

  private reset() {
    const now = this.now();
    this.signedIn = true;
    this.log = [];
    const hosts = process.env.ACE_IOS_SPIKE_ORG_HOSTS?.split(",").filter(Boolean) ?? [];
    this.orgs = hosts.length
      ? [
          {
            id: "org_acme",
            name: "Acme Robotics",
            role: "admin",
            plan: "team",
            directoryManaged: false,
            hosts,
            admin: this.admin("org_acme", "admin"),
          },
        ]
      : [];
    this.machines = [
      {
        hostId: spikeAccountMachineIds.laptop,
        name: "arpan-mbp",
        platform: "darwin",
        lastSeenAt: now - 4 * minute,
      },
      {
        hostId: spikeAccountMachineIds.studio,
        name: "studio",
        platform: "linux",
        lastSeenAt: now - 3 * day,
      },
    ];
  }
}
