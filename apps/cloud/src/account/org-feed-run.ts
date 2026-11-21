import type { AuditOutbox } from "./org-audit-outbox.ts";
import { accepts, directoryEntry } from "./org-directory.ts";
import type { KnownMember } from "./org-directory.ts";
import { opensPortal } from "./org-portal.ts";
import type { PortalRevocations } from "./org-portal.ts";
import type { OrgStore } from "./org-store.ts";
import { WorkosMembership, WorkosOrganization, WorkosUser } from "./workos-orgs.ts";
import type { WorkosEvent, WorkosOrgs } from "./workos-orgs.ts";

const fullName = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(" ") || undefined;

const keyOf = (org: string, account: string) => `${org}\u0000${account}`;

export type FeedRunDeps = {
  orgs: OrgStore;
  workos: Pick<WorkosOrgs, "getUser">;
  portal: Pick<PortalRevocations, "queueing" | "queueingAccount">;
  outbox: Pick<AuditOutbox, "queueing" | "queueingAccountRemovals">;
  now: () => number;
};

/**
 * One run of WorkOS events against the members mirror (ADR 0206 §6, amendment 1): a page of
 * the Events API, or one webhook delivery. Every decision is made on what was read from D1,
 * followed event by event through the run, so a later event on the same page sees what an
 * earlier one did. The batch it builds starts with guards on everything it read, so it commits
 * only if nothing changed since; otherwise it fails whole and the caller runs it again. Only an
 * accepted change drops org checks, queues an Admin Portal revocation or queues an audit entry,
 * and the entry is queued in that same batch.
 */
export function feedRun(deps: FeedRunDeps, lookups: { left: number }) {
  const { orgs, portal, now } = deps;
  type Row = { read: number | null; known: KnownMember | undefined };
  const rows = new Map<string, Row>();
  const users = new Map<string, { read: string | null; known: string | undefined }>();
  const memberships = new Map<string, { read: boolean; known: boolean }>();
  const touched = new Set<string>();
  const writes: D1PreparedStatement[] = [];

  /**
   * Memberships a user deletion earlier in this run tombstones, as `removingAccount`'s SQL does
   * for every row it removes: from rows this run read (each guarded) or made itself.
   */
  const tombstonedInRun = new Set<string>();
  /** A row as a user deletion earlier in this run left it (`removingAccount`'s rule). */
  const afterDeletion = (account: string, known: KnownMember | undefined) => {
    const deleted = users.get(account)?.known;
    if (!known || deleted === undefined || known.status === "removed" || known.version > deleted)
      return known;
    tombstonedInRun.add(known.membership);
    return { ...known, status: "removed", version: deleted };
  };
  async function row(org: string, account: string): Promise<Row> {
    const key = keyOf(org, account);
    let found = rows.get(key);
    if (!found) {
      const state = await orgs.memberState(org, account);
      found = { read: state?.seq ?? null, known: state };
      rows.set(key, found);
    }
    found.known = afterDeletion(account, found.known);
    return found;
  }
  async function deletedUser(account: string) {
    let found = users.get(account);
    if (!found) {
      const version = await orgs.deletedUser(account);
      found = { read: version ?? null, known: version };
      users.set(account, found);
    }
    return found;
  }
  async function deletedMembership(membership: string) {
    let found = memberships.get(membership);
    if (!found) {
      const deleted = await orgs.deletedMembership(membership);
      found = { read: deleted, known: deleted };
      memberships.set(membership, found);
    }
    return found;
  }

  /** Applies `after` to the row if it is accepted; returns what it was before, if it was. */
  async function transition(
    event: WorkosEvent,
    org: string,
    account: string,
    after: KnownMember,
  ): Promise<{ before: KnownMember | undefined } | undefined> {
    const current = await row(org, account);
    const deleted = {
      user: (await deletedUser(account)).known,
      membership:
        (await deletedMembership(after.membership)).known || tombstonedInRun.has(after.membership),
    };
    const before = current.known;
    if (!accepts(before, after, deleted)) return undefined;
    current.known = after;
    touched.add(org);
    const entry = directoryEntry(before, after, event);
    if (entry) writes.push(await deps.outbox.queueing({ ...entry, org, account }));
    writes.push(orgs.droppingChecks(org, account));
    return { before };
  }

  async function remove(event: WorkosEvent, org: string, account: string, after: KnownMember) {
    // The deletion is a fact of its own, kept whatever the row does: no later event of this
    // membership lands, even when the deletion arrives older than the row.
    const tombstone = await deletedMembership(after.membership);
    if (!tombstone.known) {
      tombstone.known = true;
      writes.push(orgs.tombstoningMembership(after.membership, after.version));
    }
    if (!(await transition(event, org, account, after))) return;
    writes.push(
      orgs.removingMember(org, account, after.membership, after.version, now(), after.role),
      portal.queueing(org, account),
    );
  }

  async function membershipEvent(event: WorkosEvent) {
    const parsed = WorkosMembership.safeParse(event.data);
    if (!parsed.success) return;
    const membership = parsed.data;
    const org = membership.organization_id;
    const account = membership.user_id;
    const version = event.created_at;
    const before = (await row(org, account)).known;
    if (event.event === "organization_membership.deleted")
      return remove(event, org, account, {
        membership: membership.id,
        role: before?.role ?? membership.role?.slug ?? "member",
        status: "removed",
        directoryManaged:
          before?.directoryManaged === true || membership.directory_managed === true,
        version,
      });
    const role = membership.role?.slug ?? "member";
    const accepted = await transition(event, org, account, {
      membership: membership.id,
      role,
      status: membership.status,
      directoryManaged: membership.directory_managed === true,
      version,
    });
    if (!accepted) return;
    let email = membership.user?.email ?? undefined;
    let name = fullName(membership.user?.first_name, membership.user?.last_name);
    if (!email && lookups.left > 0 && !(await orgs.member(org, account))?.email) {
      lookups.left--;
      try {
        const user = await deps.workos.getUser(account);
        email = user.email;
        name = fullName(user.first_name, user.last_name);
      } catch {
        // Shown without a name until the user's next update.
      }
    }
    writes.push(
      orgs.upsertingMember(
        {
          org,
          account,
          membership: membership.id,
          role,
          status: membership.status,
          directoryManaged: membership.directory_managed === true,
          email,
          name,
          version,
        },
        now(),
      ),
    );
    // A new membership opened no portal yet; any later change that takes it away revokes.
    const revokes =
      membership.status !== "active" ||
      (event.event === "organization_membership.updated" && !opensPortal(role));
    if (revokes) writes.push(portal.queueing(org, account));
  }

  async function userDeleted(event: WorkosEvent, account: string) {
    const version = event.created_at;
    const tombstone = await deletedUser(account);
    if (tombstone.known !== undefined && tombstone.known >= version) return;
    // Every membership of the account at or before the deletion, however many, in set-based
    // statements: those in D1 and those this batch made earlier alike. Entries and revocations
    // are read from the rows before they move.
    writes.push(
      deps.outbox.queueingAccountRemovals(account, event),
      portal.queueingAccount(account, version),
      ...orgs.removingAccount(account, version),
      orgs.deletingUser(account, version),
    );
    tombstone.known = version;
    // What this run knows of the account follows, so later events on the page see it.
    for (const [key, each] of rows)
      if (key.endsWith(`\u0000${account}`)) each.known = afterDeletion(account, each.known);
  }

  return {
    /** Follows one event; nothing is written until the batch commits. */
    async apply(event: WorkosEvent): Promise<void> {
      if (event.event.startsWith("organization_membership.")) return membershipEvent(event);
      if (event.event.startsWith("organization.")) {
        const parsed = WorkosOrganization.safeParse(event.data);
        if (!parsed.success) return;
        writes.push(
          event.event === "organization.deleted"
            ? orgs.deletingOrg(parsed.data.id, event.created_at, now())
            : orgs.upsertingOrg(
                { id: parsed.data.id, name: parsed.data.name, version: event.created_at },
                now(),
              ),
        );
        return;
      }
      if (event.event === "user.deleted") {
        const parsed = WorkosUser.pick({ id: true }).safeParse(event.data);
        if (parsed.success) await userDeleted(event, parsed.data.id);
        return;
      }
      if (event.event === "user.updated") {
        const parsed = WorkosUser.safeParse(event.data);
        if (!parsed.success) return;
        const user = parsed.data;
        writes.push(
          orgs.renamingAccount(
            user.id,
            user.email,
            fullName(user.first_name, user.last_name) ?? "",
            event.created_at,
          ),
        );
      }
    },
    /** The guards on what was read, which must open the batch. */
    guards(): D1PreparedStatement[] {
      const guards: D1PreparedStatement[] = [];
      for (const [key, each] of rows) {
        const [org = "", account = ""] = key.split("\u0000");
        guards.push(orgs.guards.member(org, account, each.read));
      }
      for (const [account, each] of users) guards.push(orgs.guards.deletedUser(account, each.read));
      for (const [membership, each] of memberships)
        guards.push(orgs.guards.deletedMembership(membership, each.read));
      return guards;
    },
    /** The run's writes, owners flagged again in every organization it changed. */
    writes(): D1PreparedStatement[] {
      return [...writes, ...[...touched].map((org) => orgs.flaggingOwners(org))];
    },
  };
}
