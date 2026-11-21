import { opensPortal } from "./org-portal.ts";
import type { PortalRevocations } from "./org-portal.ts";
import type { OrgStore } from "./org-store.ts";
import { WorkosMembership, WorkosOrganization, WorkosUser } from "./workos-orgs.ts";
import type { WorkosEvent, WorkosOrgs } from "./workos-orgs.ts";

/** The cursor's name in `workos_events`. */
export const MEMBERS_FEED = "members";
const PAGE_SIZE = 100;
/** Pages per run: a run that hits it leaves the rest to the next minute. */
const MAX_PAGES = 20;
/** Users fetched per run for memberships WorkOS sent without their email and name. */
const MAX_USER_LOOKUPS = 20;

const fullName = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(" ") || undefined;

/**
 * Keeps the members mirror current from WorkOS's Events API (ADR 0206 §1.1, §6): the events
 * after the stored cursor, oldest first, a page at a time. Each page is applied and the cursor
 * moved in one D1 batch, so a run that stops anywhere resumes from the last whole page, and a
 * page applied twice leaves what it left the first time. Each row keeps the time of the event it
 * reflects, so an event older than a row's state changes nothing. Any change to a membership
 * drops that member's recent org checks: the next request asks WorkOS again.
 *
 * Runs can overlap (a slow one, and the next minute's). Each page's batch commits only if the
 * cursor is still where that run read it, so a slow run never moves it back nor replays older
 * details over newer ones; it stops instead. A removal, a deactivation, or a role that opens no
 * Admin Portal intent queues the revocation of that account's portal sessions (ADR 0206 §6).
 */
export function orgEvents(deps: {
  orgs: OrgStore;
  workos: Pick<WorkosOrgs, "events" | "getUser">;
  portal: Pick<PortalRevocations, "queueing">;
  now: () => number;
}) {
  const { orgs, portal, now } = deps;

  async function statementsFor(
    event: WorkosEvent,
    touched: Set<string>,
    lookups: { left: number },
  ): Promise<D1PreparedStatement[]> {
    const version = event.created_at;
    if (event.event.startsWith("organization_membership.")) {
      const parsed = WorkosMembership.safeParse(event.data);
      if (!parsed.success) return [];
      const membership = parsed.data;
      const org = membership.organization_id;
      const account = membership.user_id;
      touched.add(org);
      const drop = orgs.droppingChecks(org, account);
      if (event.event === "organization_membership.deleted")
        return [
          orgs.removingMember(org, account, membership.id, version),
          drop,
          portal.queueing(org, account),
        ];
      const role = membership.role?.slug ?? "member";
      // A new membership opened no portal yet; any later change that takes it away revokes.
      const revokes =
        membership.status !== "active" ||
        (event.event === "organization_membership.updated" && !opensPortal(role));
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
      return [
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
        drop,
        ...(revokes ? [portal.queueing(org, account)] : []),
      ];
    }
    if (event.event.startsWith("organization.")) {
      const parsed = WorkosOrganization.safeParse(event.data);
      if (!parsed.success) return [];
      if (event.event === "organization.deleted")
        return [orgs.deletingOrg(parsed.data.id, version)];
      return [orgs.upsertingOrg({ id: parsed.data.id, name: parsed.data.name, version }, now())];
    }
    if (event.event === "user.updated") {
      const parsed = WorkosUser.safeParse(event.data);
      if (!parsed.success) return [];
      const user = parsed.data;
      return [
        orgs.renamingAccount(
          user.id,
          user.email,
          fullName(user.first_name, user.last_name) ?? "",
          version,
        ),
      ];
    }
    return [];
  }

  return {
    /** Applies every event WorkOS has after the cursor, up to the run's page limit. */
    async catchUp(): Promise<{ applied: number; pages: number }> {
      let after = await orgs.cursor(MEMBERS_FEED);
      let applied = 0;
      let pages = 0;
      const lookups = { left: MAX_USER_LOOKUPS };
      while (pages < MAX_PAGES) {
        const page = await deps.workos.events(after, PAGE_SIZE);
        if (page.count === 0 || !page.after) break;
        pages++;
        const touched = new Set<string>();
        const [guard, unguard] = orgs.guardingCursor(MEMBERS_FEED, after);
        const statements: D1PreparedStatement[] = [guard];
        for (const event of page.events)
          statements.push(...(await statementsFor(event, touched, lookups)));
        for (const org of touched) statements.push(orgs.flaggingOwners(org));
        statements.push(orgs.settingCursor(MEMBERS_FEED, page.after, now()), unguard);
        try {
          await orgs.run(statements);
        } catch (error) {
          // Another run moved the cursor since this one read it: its pages stand, this run stops.
          if ((await orgs.cursor(MEMBERS_FEED)) !== after) break;
          throw error;
        }
        applied += page.events.length;
        after = page.after;
        if (page.count < PAGE_SIZE) break;
      }
      return { applied, pages };
    },
  };
}
