/**
 * One organization's admin routes in the spike account backend (ADR 0206 amendment 4), for the
 * phone's Settings › Organization: members and roles, invitations, Admin Portal links, releasing
 * a host and the policy's versions, as `packages/client/src/ace-org.ts` calls them. A refusal
 * answers the backend's word (`last_owner`, `policy_changed`), so the phone's sentence for it
 * can be seen.
 */

interface Member {
  account: string;
  email: string;
  name: string;
  role: string;
  status: string;
  directoryManaged: boolean;
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  state: string;
  expiresAt: string;
}

export type OrgLogged =
  | { kind: "role"; account: string; role: string }
  | { kind: "remove"; account: string }
  | { kind: "invite"; email: string; role: string }
  | { kind: "revoke"; id: string }
  | { kind: "release"; hostId: string }
  | { kind: "policy"; version: number };

const refuse = (error: string, status = 409) => Response.json({ error }, { status });

export class SpikeOrgAdmin {
  readonly org: string;
  members: Member[];
  private invitations: Invitation[] = [];
  private policy = { version: 0, body: "{}" };
  private readonly log: (entry: OrgLogged) => void;

  constructor(
    org: string,
    self: Omit<Member, "status" | "directoryManaged">,
    log: (entry: OrgLogged) => void,
  ) {
    this.org = org;
    this.log = log;
    this.members = [
      { ...self, status: "active", directoryManaged: false },
      {
        account: "acct_dana",
        email: "dana@acme.example",
        name: "Dana Kim",
        role: "owner",
        status: "active",
        directoryManaged: false,
      },
      {
        account: "acct_kai",
        email: "kai@acme.example",
        name: "Kai Moss",
        role: "member",
        status: "pending",
        directoryManaged: false,
      },
      {
        account: "acct_sam",
        email: "sam@acme.example",
        name: "Sam Ruiz",
        role: "member",
        status: "active",
        directoryManaged: true,
      },
    ];
  }

  /** The reply for `orgs/{org}/{part}[/{item}]`, or undefined for a route this doesn't own. */
  async route(
    request: Request,
    part: string,
    item: string | undefined,
  ): Promise<Response | undefined> {
    const { method } = request;
    if (part === "members" && !item && method === "GET")
      return Response.json({ members: this.members });
    if (part === "members" && item && method === "PATCH") {
      const { role } = (await request.json()) as { role: string };
      return this.changeRole(item, role);
    }
    if (part === "members" && item && method === "DELETE") return this.remove(item);
    if (part === "invitations" && !item && method === "GET")
      return Response.json({ invitations: this.invitations });
    if (part === "invitations" && !item && method === "POST") {
      const { email, role } = (await request.json()) as { email: string; role: string };
      if (this.invitations.some((each) => each.email === email))
        return refuse("invitation_refused", 400);
      const invitation = {
        id: `inv_${this.invitations.length + 1}`,
        email,
        role,
        state: "pending",
        expiresAt: "2026-12-31T00:00:00.000Z",
      };
      this.invitations.push(invitation);
      this.log({ kind: "invite", email, role });
      return Response.json(invitation);
    }
    if (part === "invitations" && item && method === "DELETE") {
      this.invitations = this.invitations.filter((each) => each.id !== item);
      this.log({ kind: "revoke", id: item });
      return Response.json({});
    }
    if (part === "portal" && method === "POST") {
      const { intent } = (await request.json()) as { intent: string };
      return Response.json({ link: `https://portal.example.com/${intent}`, expiresAt: 1 });
    }
    if (part === "policy" && method === "GET")
      return Response.json({ org: this.org, ...this.policy });
    if (part === "policy" && method === "PUT") {
      const { policy, version } = (await request.json()) as { policy: unknown; version: number };
      // As the backend: only a save made over the current version is the next one.
      if (version !== this.policy.version) return refuse("policy_changed");
      this.policy = { version: this.policy.version + 1, body: JSON.stringify(policy) };
      this.log({ kind: "policy", version: this.policy.version });
      return Response.json({ org: this.org, ...this.policy });
    }
    return undefined;
  }

  private changeRole(account: string, role: string): Response {
    const member = this.members.find((each) => each.account === account);
    if (!member) return refuse("not_found", 404);
    if (member.directoryManaged) return refuse("directory_managed");
    // As ADR 0206 §1.2: only an owner gives `owner` or changes an owner's role.
    if ((role === "owner" || member.role === "owner") && !this.byOwner())
      return refuse("forbidden", 403);
    if (member.role === "owner" && role !== "owner" && this.owners() === 1)
      return refuse("last_owner");
    member.role = role;
    this.log({ kind: "role", account, role });
    return Response.json({});
  }

  private remove(account: string): Response {
    const member = this.members.find((each) => each.account === account);
    if (!member) return refuse("not_found", 404);
    if (member.role === "owner" && !this.byOwner()) return refuse("forbidden", 403);
    if (member.role === "owner" && this.owners() === 1) return refuse("last_owner");
    this.members = this.members.filter((each) => each.account !== account);
    this.log({ kind: "remove", account });
    return Response.json({});
  }

  /** The person calling is the fixture's own account, the first member. */
  private byOwner(): boolean {
    return this.members[0]?.role === "owner";
  }

  private owners(): number {
    return this.members.filter((each) => each.role === "owner").length;
  }
}
