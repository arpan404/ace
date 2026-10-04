/*
 * Usage over a range of days from the daemon's usage service: tokens per day (`usage.series`),
 * per model (`usage.summary`), and the running totals some providers report per session
 * (`usage.session_totals`, read per thread).
 */
import { UsageQuery, UsageSessionTotalsQuery, type UsageResult } from "@ace/protocol";
import { sessionCost, type SessionCost, type SessionTotalSnapshot } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/** Local calendar days, inclusive. */
export interface UsageRange {
  from: string;
  to: string;
}

const key = (range: UsageRange, view: string) => ["usage", range.from, range.to, view] as const;

/** Usage per day over the range, with API-price estimates. */
export function useDailyUsage(range: UsageRange) {
  return useDaemonQuery({
    queryKey: key(range, "day"),
    read: async (client, signal): Promise<UsageResult> => {
      const query = UsageQuery.parse({
        ...range,
        groupBy: ["day"],
        equivalentApiCost: true,
        limit: 1000,
      });
      const reply = await client.request({ type: "usage.series", query }, { signal });
      return reply.result;
    },
  });
}

/** Usage per model and provider over the whole range, busiest first. */
export function useModelUsage(range: UsageRange) {
  return useDaemonQuery({
    queryKey: key(range, "model"),
    read: async (client, signal): Promise<UsageResult> => {
      const query = UsageQuery.parse({
        ...range,
        groupBy: ["model", "provider"],
        equivalentApiCost: true,
        limit: 1000,
      });
      const reply = await client.request({ type: "usage.summary", query }, { signal });
      return reply.result;
    },
  });
}

/** Threads whose session totals are read, busiest first, and how many are read at once. */
const threadLimit = 50;
const readsAtOnce = 8;

export interface SessionCosts {
  /** Reported session cost per provider (the one that used the thread most in the range). */
  byProvider: ReadonlyMap<string | null, SessionCost>;
  /** Threads with usage in the range past the busiest ones read. */
  skipped: number;
  /** Threads whose session totals the daemon didn't give. */
  failed: number;
}

/**
 * What providers reported per session (Claude) over the sessions active in the range: the
 * busiest threads' `usage.session_totals`, keeping the snapshots taken since the range began.
 */
export function useSessionCosts(range: UsageRange) {
  return useDaemonQuery({
    queryKey: key(range, "sessions"),
    read: async (client, signal): Promise<SessionCosts> => {
      const query = UsageQuery.parse({ ...range, groupBy: ["thread", "provider"], limit: 1000 });
      const reply = await client.request({ type: "usage.summary", query }, { signal });
      const providers = new Map<string, string | null>();
      for (const row of reply.result.rows) {
        const thread = row.dimensions.thread;
        if (thread && !providers.has(thread))
          providers.set(thread, row.dimensions.provider ?? null);
      }
      const threads = [...providers.keys()].slice(0, threadLimit);
      const since = new Date(`${range.from}T00:00:00`).getTime();
      const snapshots = new Map<string | null, SessionTotalSnapshot[]>();
      let failed = 0;
      for (let start = 0; start < threads.length; start += readsAtOnce) {
        const batch = threads.slice(start, start + readsAtOnce);
        const pages = await Promise.allSettled(
          batch.map((thread) =>
            client.request(
              {
                type: "usage.session_totals",
                query: UsageSessionTotalsQuery.parse({ thread, limit: 100 }),
              },
              { signal },
            ),
          ),
        );
        signal.throwIfAborted();
        pages.forEach((page, index) => {
          if (page.status === "rejected") {
            failed += 1;
            return;
          }
          const provider = providers.get(batch[index] ?? "") ?? null;
          const list = snapshots.get(provider) ?? [];
          list.push(...page.value.totals.filter((total) => total.at >= since));
          snapshots.set(provider, list);
        });
      }
      return {
        byProvider: new Map(
          [...snapshots].map(([provider, list]) => [provider, sessionCost(list)] as const),
        ),
        skipped: providers.size - threads.length,
        failed,
      };
    },
  });
}
