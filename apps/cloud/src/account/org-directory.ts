import type { WorkosEvent } from "./workos-orgs.ts";

/** A membership as the mirror holds it: `status` is WorkOS's, or `removed` once deleted. */
export type KnownMember = {
  membership: string;
  role: string;
  status: string;
  directoryManaged: boolean;
  /** The WorkOS time of the state the row reflects. */
  version: string;
};

/** One audit entry for a change WorkOS reported that ace's own routes didn't make. */
export type DirectoryEntry = {
  org: string;
  account: string;
  action:
    | "org.member.joined"
    | "org.member.role_changed"
    | "org.member.removed"
    | "org.member.deprovisioned"
    | "org.member.reactivated";
  /** `idp` for a directory-managed membership; `workos` for any other change WorkOS made. */
  actor: "idp" | "workos";
  /** Role slugs and statuses before and after: names, never a person's details. */
  metadata: Record<string, string>;
  /** The WorkOS event: one entry per event, however often it is applied. */
  event: string;
  occurredAt: string;
};

/** What WorkOS deleted that a membership event could otherwise bring back. */
export type Deleted = {
  /** When WorkOS deleted the user, if it did. */
  user: string | undefined;
  /** Whether WorkOS deleted this very membership. */
  membership: boolean;
};

/**
 * Whether one event moves the mirror's row (ADR 0206 §6, amendment 1): only a strictly newer
 * one, so a repeat changes nothing; at the same WorkOS time, a removal wins over anything else.
 * Nothing but a removal lands for a membership WorkOS deleted, or at or before the time WorkOS
 * deleted its user.
 */
export function accepts(
  before: KnownMember | undefined,
  after: KnownMember,
  deleted: Deleted,
): boolean {
  if (after.status !== "removed") {
    if (deleted.membership) return false;
    if (deleted.user !== undefined && deleted.user >= after.version) return false;
  }
  if (!before) return true;
  if (after.version > before.version) return true;
  return (
    after.version === before.version && after.status === "removed" && before.status !== "removed"
  );
}

/**
 * Which audit entry, if any, an accepted membership change makes (ADR 0206 §4.1, §6). ace's own
 * Remove and role change write their entries themselves, naming the member who acted; here are
 * the changes only the directory or WorkOS makes: a directory-managed membership joining,
 * changing role or being deleted, and any deactivation or reactivation (ace never deactivates).
 */
export function directoryEntry(
  before: KnownMember | undefined,
  after: KnownMember,
  event: Pick<WorkosEvent, "id" | "created_at">,
): Omit<DirectoryEntry, "org" | "account"> | undefined {
  if (before?.status === "removed" && after.status === "removed") return undefined;
  const managed = after.directoryManaged || before?.directoryManaged === true;
  const actor = managed ? "idp" : "workos";
  const base = { actor, event: event.id, occurredAt: event.created_at } as const;
  const roles = { role_before: before?.role ?? "", role_after: after.role };
  const statuses = { status_before: before?.status ?? "", status_after: after.status };
  if (after.status === "removed")
    return managed && before
      ? { ...base, action: "org.member.removed", metadata: { role_before: before.role } }
      : undefined;
  if (after.status === "inactive" && before?.status !== "inactive")
    return { ...base, action: "org.member.deprovisioned", metadata: { ...roles, ...statuses } };
  if (after.status === "active" && before?.status === "inactive")
    return { ...base, action: "org.member.reactivated", metadata: { ...roles, ...statuses } };
  if (!managed) return undefined;
  if (after.status === "active" && (!before || before.status === "removed"))
    return { ...base, action: "org.member.joined", metadata: { role_after: after.role } };
  if (before && before.role !== after.role)
    return { ...base, action: "org.member.role_changed", metadata: roles };
  return undefined;
}
