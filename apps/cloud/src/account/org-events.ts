import type { AuditOutbox } from "./org-audit-outbox.ts";
import { feedRun } from "./org-feed-run.ts";
import type { FeedRunDeps } from "./org-feed-run.ts";
import type { OrgStore } from "./org-store.ts";
import { MIRRORED_EVENTS } from "./workos-orgs.ts";
import type { WorkosEvent, WorkosOrgs } from "./workos-orgs.ts";

/** The cursor's name in `workos_events`. */
export const MEMBERS_FEED = "members";
const PAGE_SIZE = 100;
/** Pages per run: a run that hits it leaves the rest to the next minute. */
const MAX_PAGES = 20;
/** Users fetched per run for memberships WorkOS sent without their email and name. */
const MAX_USER_LOOKUPS = 20;
/** Tries of one page or delivery whose batch found what it read had changed. */
const ATTEMPTS = 4;

const mirrored = new Set<string>(MIRRORED_EVENTS);

/**
 * Keeps the members mirror current from WorkOS's Events API (ADR 0206 §1.1, §6): the events
 * after the stored cursor, oldest first, a page at a time, each page applied and the cursor
 * moved in one D1 batch. A webhook delivery (`deliver`) applies its one event the same way, at
 * once, without the cursor.
 *
 * A run decides every change on what it read (`org-feed-run.ts`) and its batch commits only if
 * that still holds, so overlapping runs (a slow one and the next minute's, or two deliveries)
 * never apply or log a change over a newer one: the loser reads again and decides again. A page
 * whose cursor another run moved stops the run instead. Audit entries are queued in the batch
 * and sent after it (`org-audit-outbox.ts`), so an entry exists exactly for a change that
 * committed, and a WorkOS outage only delays it.
 */
export function orgEvents(
  deps: Omit<FeedRunDeps, "workos" | "outbox"> & {
    orgs: OrgStore;
    workos: Pick<WorkosOrgs, "events" | "getUser">;
    outbox: Pick<AuditOutbox, "queueing" | "drain">;
  },
) {
  const { orgs, now } = deps;

  async function sendAudit() {
    await deps.outbox.drain();
  }

  return {
    /**
     * One event WorkOS delivered to the webhook, applied now. Events the mirror doesn't follow
     * change nothing; a D1 failure is passed on, so WorkOS delivers it again.
     */
    async deliver(event: WorkosEvent): Promise<void> {
      if (!mirrored.has(event.event)) return;
      for (let attempt = 1; ; attempt++) {
        const run = feedRun(deps, { left: MAX_USER_LOOKUPS });
        await run.apply(event);
        try {
          await orgs.run([...run.guards(), ...run.writes(), orgs.guards.done()]);
          break;
        } catch (error) {
          if (attempt >= ATTEMPTS) throw error;
        }
      }
      await sendAudit();
    },
    /** Applies every event WorkOS has after the cursor, up to the run's page limit. */
    async catchUp(): Promise<{ applied: number; pages: number }> {
      let after = await orgs.cursor(MEMBERS_FEED);
      let applied = 0;
      let pages = 0;
      const lookups = { left: MAX_USER_LOOKUPS };
      try {
        while (pages < MAX_PAGES) {
          const page = await deps.workos.events(after, PAGE_SIZE);
          if (page.count === 0 || !page.after) break;
          pages++;
          let committed = false;
          for (let attempt = 1; !committed; attempt++) {
            const run = feedRun(deps, lookups);
            for (const event of page.events) await run.apply(event);
            const [cursor] = orgs.guardingCursor(MEMBERS_FEED, after);
            try {
              await orgs.run([
                cursor,
                ...run.guards(),
                ...run.writes(),
                orgs.settingCursor(MEMBERS_FEED, page.after, now()),
                orgs.guards.done(),
              ]);
              committed = true;
            } catch (error) {
              // Another run moved the cursor since this one read it: its pages stand, this
              // run stops. Otherwise a row changed under this page: decide it again.
              if ((await orgs.cursor(MEMBERS_FEED)) !== after) return { applied, pages };
              if (attempt >= ATTEMPTS) throw error;
            }
          }
          applied += page.events.length;
          after = page.after;
          if (page.count < PAGE_SIZE) break;
        }
        return { applied, pages };
      } finally {
        await sendAudit();
      }
    },
    /** Sends the audit entries that are due (the minute's cron). */
    sendAudit,
  };
}
export type OrgEvents = ReturnType<typeof orgEvents>;
