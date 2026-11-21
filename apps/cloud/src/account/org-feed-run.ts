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
  portal: Pick<PortalRevocations, "queueing">;
  outbox: Pick<AuditOutbox, "queueing">;
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
  const accounts = new Map<string, number>();
  const touched = new Set<string>();
  const writes: D1PreparedStatement[] = [];

  async function row(org: string, account: string): Promise<Row> {
    const key = keyOf(org, account);
    let found = rows.get(key);
    if (!found) {
      const state = await orgs.memberState(org, account);
      found = { read: state?.seq ?? null, known: state };
      rows.set(key, found);
    }
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
      membership: (await deletedMembership(after.membership)).known,
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
    if (!(await transition(event, org, account, after))) return;
    const tombstone = await deletedMembership(after.membership);
    tombstone.known = true;
    writes.push(
      orgs.removingMember(org, account, after.membership, after.version, now(), after.role),
      orgs.tombstoningMembership(after.membership, after.version),
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
    if (!accounts.has(account)) {
      const stored = await orgs.accountMemberships(account);
      accounts.set(account, stored.length);
      for (const state of stored)
        if (!rows.has(keyOf(state.org, account)))
          rows.set(keyOf(state.org, account), { read: state.seq, known: state });
    }
    // Every row of the account this run knows: those in D1 and those made earlier in the run.
    for (const [key, each] of rows) {
      const [org = "", owner = ""] = key.split("\u0000");
      if (owner !== account || !each.known || each.known.status === "removed") continue;
      await remove(event, org, account, { ...each.known, status: "removed", version });
    }
    tombstone.known = version;
    writes.push(orgs.deletingUser(account, version));
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
            ? orgs.deletingOrg(parsed.data.id, event.created_at)
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
      for (const [account, count] of accounts) guards.push(orgs.guards.accountRows(account, count));
      return guards;
    },
    /** The run's writes, owners flagged again in every organization it changed. */
    writes(): D1PreparedStatement[] {
      return [...writes, ...[...touched].map((org) => orgs.flaggingOwners(org))];
    },
  };
}
