import { z } from "zod";
import { policyBodySha256, signOrgRoster, type GrantSigningKey } from "@ace/account-grant";
import { AceOrgId, AceOrgRosterBody, type AceOrgRoster } from "@ace/protocol/ace-org";
import { HostId } from "@ace/relay/wire";
import type { OrgStore } from "./org-store.ts";
import type { PrincipalReader } from "./principal.ts";
import { bearer, fail, json } from "./respond.ts";

const Served = z.object({ version: z.number(), body_sha256: z.string() });

/** How many times a roster is read again when another request took its next version first. */
const VERSION_TRIES = 4;

/**
 * The roster's body as text, the same for the same members and hosts in any order: members by
 * account, hosts by id. Its SHA-256 is what the statement signs.
 */
export function rosterBody(
  members: Awaited<ReturnType<OrgStore["members"]>>,
  hosts: readonly { hostId: string }[],
): string {
  const body: AceOrgRosterBody = {
    members: members
      .map((member) => ({
        account: member.account,
        status: member.status,
        role: member.role,
        ...(member.name ? { name: member.name } : {}),
        ...(member.email ? { email: member.email } : {}),
      }))
      .toSorted((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0)),
    hosts: hosts
      .map((host) => ({ id: host.hostId }))
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return JSON.stringify(body);
}

/**
 * GET /v1/orgs/{org}/hosts/{hostId}/roster (ADR 0209 §7.2): the organization's members as the
 * members mirror has them, signed with the grant key for one host, answered only to that host's
 * own organization credential. The version grows each time the body served changes, so a host
 * that never takes a lower one can't be handed an old roster that still lists a removed member.
 * `at` is the backend's clock when signed: how fresh the host may call it.
 */
export function orgRosterRoute(deps: {
  db: D1Database;
  principals: PrincipalReader;
  orgs: Pick<OrgStore, "members" | "hosts" | "credentialOrg">;
  signingKey: GrantSigningKey;
  now: () => number;
}) {
  const { db } = deps;

  /** The version for `sha256`: the one served last if the body is the same, else the next. */
  async function versionFor(org: string, sha256: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < VERSION_TRIES; attempt++) {
      const raw = await db
        .prepare("SELECT version, body_sha256 FROM org_rosters WHERE org_id = ?")
        .bind(org)
        .first();
      const served = raw ? Served.parse(raw) : undefined;
      if (served?.body_sha256 === sha256) return served.version;
      const next = (served?.version ?? 0) + 1;
      // Taken only from the version read: a request that moved it first makes this one read again.
      const taken = await db
        .prepare(
          `INSERT INTO org_rosters (org_id, version, body_sha256) VALUES (?1, ?2, ?3)
           ON CONFLICT (org_id) DO UPDATE SET version = excluded.version, body_sha256 = excluded.body_sha256
           WHERE org_rosters.version = ?2 - 1`,
        )
        .bind(org, next, sha256)
        .run();
      if (taken.meta.changes > 0) return next;
    }
    return undefined;
  }

  return async (request: Request, org: string, hostId: string): Promise<Response> => {
    const id = AceOrgId.safeParse(org);
    if (!id.success || !HostId.safeParse(hostId).success) return fail(404, "not_found");
    const token = bearer(request);
    const principal = token ? await deps.principals.read(token) : undefined;
    if (!principal) return fail(401, "unauthenticated");
    // Only the host's own organization credential, bound to its current enrollment in `org`.
    if (
      principal.kind !== "machine" ||
      principal.org !== id.data ||
      principal.hostId !== hostId ||
      (await deps.orgs.credentialOrg(principal.hash)) !== id.data
    )
      return fail(403, "not_org_host");
    const body = rosterBody(await deps.orgs.members(id.data), await deps.orgs.hosts(id.data));
    const sha256 = policyBodySha256(body);
    const version = await versionFor(id.data, sha256);
    if (version === undefined) return fail(503, "busy");
    const statement = signOrgRoster(
      { org: id.data, host: hostId, version, at: deps.now(), body_sha256: sha256 },
      deps.signingKey,
    );
    const answer: AceOrgRoster = { body, statement };
    return json(200, answer);
  };
}
