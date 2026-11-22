import { z } from "zod";
import { policyBodySha256, signOrgRoster, type GrantSigningKey } from "@ace/account-grant";
import { AceOrgId, type AceOrgRoster, type AceOrgRosterBody } from "@ace/protocol/ace-org";
import { HostId } from "@ace/relay/wire";
import type { OrgStore } from "./org-store.ts";
import type { PrincipalReader } from "./principal.ts";
import { bearer, fail, json } from "./respond.ts";

const MemberRow = z.object({
  account_id: z.string(),
  status: z.string(),
  role: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  version: z.string(),
});
const HostRow = z.object({ host_id: z.string() });
const Served = z.object({ version: z.number(), body_sha256: z.string() });
const Revision = z.object({ revision: z.string() });

/** How many times a roster is read again when its members changed before it took a version. */
const SNAPSHOT_TRIES = 4;

/**
 * The members' and hosts' revision: every committed change to a member's status or role bumps
 * that row's `seq` and no row is ever deleted, so the count and sum of `seq` move with each one;
 * the hosts are listed whole. Names and emails don't move it: a roster versioned while only they
 * changed carries the members' current access with an older name.
 */
const revisionSql = `SELECT
  (SELECT COUNT(*) || ':' || COALESCE(SUM(seq), 0) FROM org_members WHERE org_id = ?1) || '/' ||
  (SELECT COALESCE(group_concat(host_id, ','), '')
     FROM (SELECT host_id FROM org_hosts WHERE org_id = ?1 ORDER BY host_id)) AS revision`;

export type RosterSnapshot = {
  body: string;
  sha256: string;
  revision: string;
  served: { version: number; sha256: string } | undefined;
};

/**
 * The roster as one committed state of the members mirror (ADR 0209 §7.2): its members (the
 * removed ones too, with WorkOS's time for their state), hosts, revision and the version last
 * served, all read in one D1 batch, which is one transaction.
 */
export async function rosterSnapshot(db: D1Database, org: string): Promise<RosterSnapshot> {
  const [members, hosts, served, revision] = await db.batch([
    db
      .prepare(
        "SELECT account_id, status, role, name, email, version FROM org_members WHERE org_id = ? ORDER BY account_id LIMIT 10000",
      )
      .bind(org),
    db
      .prepare("SELECT host_id FROM org_hosts WHERE org_id = ? ORDER BY host_id LIMIT 1000")
      .bind(org),
    db.prepare("SELECT version, body_sha256 FROM org_rosters WHERE org_id = ?").bind(org),
    db.prepare(revisionSql).bind(org),
  ]);
  const body: AceOrgRosterBody = {
    members: (members?.results ?? []).map((raw) => {
      const row = MemberRow.parse(raw);
      const member: AceOrgRosterBody["members"][number] = {
        account: row.account_id,
        status:
          row.status === "active" || row.status === "pending" || row.status === "inactive"
            ? row.status
            : "removed",
        role: row.role,
      };
      if (row.name) member.name = row.name;
      if (row.email) member.email = row.email;
      if (row.version) member.changed = row.version;
      return member;
    }),
    hosts: (hosts?.results ?? []).map((raw) => ({ id: HostRow.parse(raw).host_id })),
  };
  const text = JSON.stringify(body);
  const last = served?.results[0];
  const kept = last ? Served.parse(last) : undefined;
  return {
    body: text,
    sha256: policyBodySha256(text),
    revision: Revision.parse(revision?.results[0]).revision,
    served: kept ? { version: kept.version, sha256: kept.body_sha256 } : undefined,
  };
}

/**
 * The version `snapshot` is served at: the last one if its body is the one served then, else the
 * next, taken only while the members are still at the snapshot's revision and nobody took that
 * version first. Undefined when either moved: the caller reads again, so a snapshot read before
 * a removal can never take a version after the removal's.
 */
export async function claimRosterVersion(
  db: D1Database,
  org: string,
  snapshot: RosterSnapshot,
): Promise<number | undefined> {
  if (snapshot.served?.sha256 === snapshot.sha256) return snapshot.served.version;
  const next = (snapshot.served?.version ?? 0) + 1;
  const taken = await db
    .prepare(
      `INSERT INTO org_rosters (org_id, version, body_sha256)
       SELECT ?1, ?2, ?3 WHERE (${revisionSql}) = ?4
       ON CONFLICT (org_id) DO UPDATE SET version = excluded.version, body_sha256 = excluded.body_sha256
       WHERE org_rosters.version = ?2 - 1`,
    )
    .bind(org, next, snapshot.sha256, snapshot.revision)
    .run();
  return taken.meta.changes > 0 ? next : undefined;
}

/**
 * GET /v1/orgs/{org}/hosts/{hostId}/roster (ADR 0209 §7.2): the organization's members as one
 * committed state of the members mirror, signed with the grant key for one host, answered only to
 * that host's own organization credential. `epoch` is the backend's restore generation and `at`
 * its clock when signed.
 */
export function orgRosterRoute(deps: {
  db: D1Database;
  principals: PrincipalReader;
  orgs: Pick<OrgStore, "credentialOrg">;
  signingKey: GrantSigningKey;
  epoch: number;
  now: () => number;
}) {
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
    for (let attempt = 0; attempt < SNAPSHOT_TRIES; attempt++) {
      const snapshot = await rosterSnapshot(deps.db, id.data);
      const version = await claimRosterVersion(deps.db, id.data, snapshot);
      if (version === undefined) continue;
      const statement = signOrgRoster(
        {
          org: id.data,
          host: hostId,
          epoch: deps.epoch,
          version,
          at: deps.now(),
          body_sha256: snapshot.sha256,
        },
        deps.signingKey,
      );
      const answer: AceOrgRoster = { body: snapshot.body, statement };
      return json(200, answer);
    }
    return fail(503, "busy");
  };
}
