import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import {
  OutsideClientKind,
  OutsideGrant,
  ThreadId,
  type OutsideGrantEntry,
  type OutsideProjects,
  type OutsideScope,
} from "@ace/protocol";
import { normalScopes } from "./scopes.ts";

/** The SQLite the grants live in: the daemon store's statements and transactions. */
export interface GrantSql {
  statement(sql: string): StatementSync;
  atomic<T>(run: () => T): T;
}

/** What a new grant is made of; the store stamps its id and creation time. */
export interface GrantDraft {
  clientKind: OutsideClientKind;
  clientId: string;
  name: string;
  domain: string | null;
  scopes: readonly OutsideScope[];
  projects: OutsideProjects;
  expiresAt: number | null;
  approvedBy: string;
}

export type GrantChange = Partial<Pick<OutsideGrant, "scopes" | "projects" | "expiresAt">>;

const Row = z.object({
  id: z.string(),
  client_kind: OutsideClientKind,
  client_id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  scopes: z.string(),
  projects: z.string(),
  created_at: z.number(),
  expires_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
  approved_by: z.string(),
});
const columns =
  "id,client_kind,client_id,name,domain,scopes,projects,created_at,expires_at,last_used_at,revoked_at,approved_by";

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function decode(raw: unknown): OutsideGrant | undefined {
  const row = Row.safeParse(raw);
  if (!row.success) return undefined;
  const { data } = row;
  const grant = OutsideGrant.safeParse({
    id: data.id,
    clientKind: data.client_kind,
    clientId: data.client_id,
    name: data.name,
    domain: data.domain,
    scopes: json(data.scopes),
    projects: json(data.projects),
    createdAt: data.created_at,
    expiresAt: data.expires_at,
    lastUsedAt: data.last_used_at,
    revokedAt: data.revoked_at,
    approvedBy: data.approved_by,
  });
  // A row this build can't read grants nothing; it stays for a build that can.
  return grant.success ? grant.data : undefined;
}

/** A live grant, with `?` the time now; `isLive` states the same rule. */
const liveSql = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
/** How many ended grants Settings lists beside every live one. */
export const endedListed = 200;
/** How often a grant's last use is written: every request would be a write per call. */
const touchEveryMs = 60_000;

/**
 * Every outside grant on this machine (ADR 0117). Reads go to SQLite each time, so a revoke or
 * an expiry applies to the next request, including after a restart.
 */
export class GrantStore {
  private sql: GrantSql;
  private now: () => number;
  private id: () => string;
  constructor(sql: GrantSql, now: () => number, id: () => string) {
    this.sql = sql;
    this.now = now;
    this.id = id;
  }
  create(draft: GrantDraft): OutsideGrant {
    const grant = OutsideGrant.parse({
      ...draft,
      id: this.id(),
      scopes: normalScopes(draft.scopes),
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
    });
    this.sql
      .statement(`INSERT INTO outside_grants (${columns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        grant.id,
        grant.clientKind,
        grant.clientId,
        grant.name,
        grant.domain,
        JSON.stringify(grant.scopes),
        JSON.stringify(grant.projects),
        grant.createdAt,
        grant.expiresAt,
        null,
        null,
        grant.approvedBy,
      );
    return grant;
  }
  get(id: string): OutsideGrant | undefined {
    return decode(this.sql.statement(`SELECT ${columns} FROM outside_grants WHERE id=?`).get(id));
  }
  /** The grant if it may act now: not revoked and not expired. */
  live(id: string): OutsideGrant | undefined {
    const grant = this.get(id);
    return grant && isLive(grant, this.now()) ? grant : undefined;
  }
  /**
   * Every live grant, then the most recent ended (revoked or expired) ones up to
   * `endedListed`, each part newest first. A live grant never falls off the list.
   */
  list(): OutsideGrant[] {
    const ended = this.sql
      .statement(
        `SELECT ${columns} FROM outside_grants WHERE NOT (${liveSql}) ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(this.now(), endedListed)
      .flatMap((row) => decode(row) ?? []);
    return [...this.liveGrants(), ...ended];
  }
  /** Every grant with the threads it started and messaged, newest first. */
  entries(): OutsideGrantEntry[] {
    const threads = this.sql.statement(
      "SELECT thread_id FROM outside_grant_threads WHERE grant_id=? AND kind=? ORDER BY at DESC LIMIT 256",
    );
    const read = (id: string, kind: string) =>
      threads.all(id, kind).flatMap((row) => {
        const parsed = ThreadId.safeParse(row["thread_id"]);
        return parsed.success ? [parsed.data] : [];
      });
    return this.list().map((grant) =>
      Object.assign(grant, {
        started: read(grant.id, "started"),
        messaged: read(grant.id, "messaged"),
      }),
    );
  }
  /** Marks the grant revoked and keeps its row; false when it was already gone. */
  revoke(id: string): boolean {
    const changed = this.sql
      .statement("UPDATE outside_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(this.now(), id);
    return Number(changed.changes) > 0;
  }
  /** Changes a live grant's scopes, projects or expiry; undefined when it is not live. */
  update(id: string, change: GrantChange): OutsideGrant | undefined {
    return this.sql.atomic(() => {
      const grant = this.live(id);
      if (!grant) return undefined;
      const next = OutsideGrant.parse({
        ...grant,
        ...(change.scopes ? { scopes: normalScopes(change.scopes) } : {}),
        ...(change.projects ? { projects: change.projects } : {}),
        ...(change.expiresAt !== undefined ? { expiresAt: change.expiresAt } : {}),
      });
      this.sql
        .statement("UPDATE outside_grants SET scopes=?, projects=?, expires_at=? WHERE id=?")
        .run(JSON.stringify(next.scopes), JSON.stringify(next.projects), next.expiresAt, id);
      return next;
    });
  }
  /** Records a use, at most once a minute per grant. */
  touch(grant: OutsideGrant): void {
    const now = this.now();
    if (grant.lastUsedAt !== null && now - grant.lastUsedAt < touchEveryMs) return;
    this.sql.statement("UPDATE outside_grants SET last_used_at=? WHERE id=?").run(now, grant.id);
  }
  /** Notes a thread the grant started or messaged, for its row in Settings. */
  noteThread(grantId: string, threadId: ThreadId, kind: "started" | "messaged"): void {
    this.sql
      .statement(
        "INSERT INTO outside_grant_threads (grant_id, thread_id, kind, at) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET at=excluded.at",
      )
      .run(grantId, threadId, kind, this.now());
  }
  /** Grants that are neither revoked nor expired, for timers armed at startup. */
  liveGrants(): OutsideGrant[] {
    return this.sql
      .statement(
        `SELECT ${columns} FROM outside_grants WHERE ${liveSql} ORDER BY created_at DESC, id`,
      )
      .all(this.now())
      .flatMap((row) => decode(row) ?? []);
  }
}

export function isLive(grant: OutsideGrant, now: number): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);
}
