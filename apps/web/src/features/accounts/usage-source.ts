/*
 * Usage over a range of days from the daemon's usage service: tokens per day (`usage.series`),
 * per model (`usage.summary`), and what providers reported they charged: per step in the usage
 * rows, per session in `usage.session_totals` (read per thread).
 */
import type { ClientApi } from "@ace/client";
import {
  UsageQuery,
  UsageSessionTotalsQuery,
  type UsageDimension,
  type UsageResult,
} from "@ace/protocol";
import {
  dayStart,
  sessionCostsByProvider,
  type SessionCostsByProvider,
  type ThreadSessionTotals,
} from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/** Calendar days of the daemon's time zone, inclusive; wait until `ready` (the zone is known). */
export interface UsageRange {
  from: string;
  to: string;
  timeZone: string | undefined;
  ready: boolean;
}

const key = (range: UsageRange, view: string) =>
  ["usage", range.from, range.to, range.timeZone ?? "", view] as const;

function summary(
  client: ClientApi,
  range: UsageRange,
  groupBy: UsageDimension[],
  signal: AbortSignal,
  limit = 1000,
): Promise<UsageResult> {
  const query = UsageQuery.parse({
    from: range.from,
    to: range.to,
    groupBy,
    equivalentApiCost: true,
    limit,
  });
  return client.request({ type: "usage.summary", query }, { signal }).then((reply) => reply.result);
}

/** Usage per day over the range, with API-price estimates. */
export function useDailyUsage(range: UsageRange) {
  return useDaemonQuery({
    queryKey: key(range, "day"),
    enabled: range.ready,
    read: async (client, signal): Promise<UsageResult> => {
      const query = UsageQuery.parse({
        from: range.from,
        to: range.to,
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
    enabled: range.ready,
    read: (client, signal) => summary(client, range, ["model", "provider"], signal),
  });
}

/** Usage per account and provider over the whole range, busiest first. */
export function useAccountUsage(range: UsageRange, enabled: boolean) {
  return useDaemonQuery({
    queryKey: key(range, "account"),
    enabled: range.ready && enabled,
    read: (client, signal) => summary(client, range, ["account", "provider"], signal),
  });
}

/** Threads whose session totals are read, busiest first, how many at once, and a page's rows. */
const threadLimit = 50;
const readsAtOnce = 8;
const pageRows = 100;

export interface ReportedCosts {
  /** Per-step dollars per provider, from rows grouped by provider (no model-table limit). */
  perStep: ReadonlyMap<string | null, number>;
  sessions: SessionCostsByProvider;
  /** Where the session totals fall short of every session in the range. */
  gaps: {
    /** Threads with usage in the range that weren't read (past the busiest, or unlisted). */
    unread: number;
    /** More threads than the daemon listed, so `unread` is a floor. */
    unlisted: boolean;
    /** Threads whose session totals the daemon didn't give. */
    failed: number;
    /** Threads with more snapshots than one page, so their oldest sessions are left out. */
    clipped: number;
  };
  /** The per-provider rows were cut short (more providers than one reply carries). */
  truncated: boolean;
}

/**
 * What providers reported over the range: per-step dollars per provider, and the sessions active
 * in it (snapshots taken since the range began, in the daemon's zone) of the busiest threads,
 * each session counted once across threads and given to the provider that ran it.
 */
export function useReportedCosts(range: UsageRange) {
  return useDaemonQuery({
    queryKey: key(range, "reported"),
    enabled: range.ready,
    read: async (client, signal): Promise<ReportedCosts> => {
      const [byProvider, byThread, byModel] = await Promise.all([
        summary(client, range, ["provider"], signal, 100),
        summary(client, range, ["thread", "provider"], signal),
        summary(client, range, ["model", "provider"], signal),
      ]);
      const perStep = new Map<string | null, number>();
      for (const row of byProvider.rows)
        perStep.set(row.dimensions.provider ?? null, row.totals.providerReportedUsd);
      const providers = new Map<string, Set<string>>();
      for (const row of byThread.rows) {
        const thread = row.dimensions.thread;
        if (!thread) continue;
        const set = providers.get(thread) ?? new Set<string>();
        if (row.dimensions.provider) set.add(row.dimensions.provider);
        providers.set(thread, set);
      }
      const modelProviders = new Map<string, Set<string>>();
      for (const row of byModel.rows) {
        const { model, provider } = row.dimensions;
        if (!model || !provider) continue;
        modelProviders.set(model, (modelProviders.get(model) ?? new Set()).add(provider));
      }
      const modelProvider = (model: string) => {
        const set = modelProviders.get(model);
        return set?.size === 1 ? [...set][0] : undefined;
      };
      const threads = [...providers.keys()].slice(0, threadLimit);
      const since = dayStart(range.from, range.timeZone);
      const read: ThreadSessionTotals[] = [];
      let failed = 0;
      let clipped = 0;
      for (let start = 0; start < threads.length; start += readsAtOnce) {
        const batch = threads.slice(start, start + readsAtOnce);
        const pages = await Promise.allSettled(
          batch.map((thread) =>
            client.request(
              {
                type: "usage.session_totals",
                query: UsageSessionTotalsQuery.parse({ thread, limit: pageRows }),
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
          if (page.value.totals.length >= pageRows) clipped += 1;
          read.push({
            providers: providers.get(batch[index] ?? "") ?? [],
            snapshots: page.value.totals.filter((total) => total.at >= since),
          });
        });
      }
      return {
        perStep,
        sessions: sessionCostsByProvider(read, modelProvider),
        gaps: {
          unread: providers.size - threads.length,
          unlisted: byThread.truncated,
          failed,
          clipped,
        },
        truncated: byProvider.truncated,
      };
    },
  });
}
