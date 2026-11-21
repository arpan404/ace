/**
 * What each organization role may do in ace (ADR 0206 §1.2). Roles are WorkOS environment role
 * slugs; ace authorizes from this table, compiled into the backend and the daemon, and never from
 * the access token's `permissions` claim alone, so a WorkOS dashboard edit can't widen a role.
 * A role ace doesn't know (an organization's custom `org…` role, or one added later) is kept as
 * WorkOS gave it and authorizes as `member`. Pure: no I/O.
 */

export type OrgPermission =
  | "bots:use"
  | "bots:create"
  | "members:manage"
  | "policy:set"
  | "hosts:manage"
  | "bots:manage"
  | "registry:publish"
  | "audit:read"
  | "sso:manage"
  | "org:delete"
  | "org:owners"
  | "registry:key"
  | "audit:retention"
  | "host:shell"
  | "billing:manage";

/** The roles ace knows. `billing` is defined for M6 and assigned to nobody yet. */
export type OrgRole = "owner" | "admin" | "member" | "billing";

const member: readonly OrgPermission[] = ["bots:use", "bots:create"];
const admin: readonly OrgPermission[] = [
  ...member,
  "members:manage",
  "policy:set",
  "hosts:manage",
  "bots:manage",
  "registry:publish",
  "audit:read",
  "sso:manage",
];
const table: Record<OrgRole, ReadonlySet<OrgPermission>> = {
  owner: new Set([
    ...admin,
    "org:delete",
    "org:owners",
    "registry:key",
    "audit:retention",
    "host:shell",
  ]),
  admin: new Set(admin),
  member: new Set(member),
  billing: new Set(["billing:manage", "audit:read"]),
};

/** The role a WorkOS role slug acts as in ace: an unknown slug acts as `member`. */
export function orgRole(slug: string): OrgRole {
  return slug === "owner" || slug === "admin" || slug === "billing" ? slug : "member";
}

/** Whether a WorkOS role slug may do `permission` in ace. */
export function orgAllows(slug: string, permission: OrgPermission): boolean {
  return table[orgRole(slug)].has(permission);
}
