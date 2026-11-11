import { UsageQuery } from "@ace/protocol";
import {
  railUsage,
  usageDay,
  usageHeadroom,
  usageLimits,
  type PooledHeadroom,
  type RailUsage,
} from "@ace/ui-core";
import { useMemo } from "react";
import { useProviderAccountModels } from "@/lib/account-views.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useRailMeasure } from "@/lib/rail-measure.ts";
import { useRailPins } from "@/lib/rail-pins.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";

export interface UsageHeadroom {
  headroom: PooledHeadroom[];
  rail: RailUsage;
  /** When the freshest limit was read; undefined before any. */
  observedAt: number | undefined;
  now: number;
}

/**
 * This machine's room, for the rail's Usage bars (the pinned accounts, else the four used most
 * this week) and their card, which lists the same accounts with every window. Limits come from the app's live accounts read (a provider's limit push updates it);
 * the seven-day ranking of accounts is read again only when a limit changes, never on a timer.
 */
export function useUsageHeadroom(): UsageHeadroom {
  const now = useNow();
  const accounts = useProviderAccountModels().accounts.data;
  const zone = useUsageTimeZone();
  const observedAt = useMemo(() => {
    let latest: number | undefined;
    for (const account of accounts ?? [])
      for (const at of [account.quota.observedAt, ...account.windows.map((w) => w.observedAt ?? 0)])
        if (at > 0 && (latest === undefined || at > latest)) latest = at;
    return latest;
  }, [accounts]);
  const from = usageDay(now, zone.timeZone, 6);
  const to = usageDay(now, zone.timeZone);
  const used = useDaemonQuery<ReadonlyMap<string, number>>({
    queryKey: ["usage", "rail", from, to, observedAt ?? 0],
    enabled: zone.ready,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
    read: async (client, signal) => {
      const query = UsageQuery.parse({ from, to, groupBy: ["account"], limit: 100 });
      const reply = await client.request({ type: "usage.summary", query }, { signal });
      return new Map(
        reply.result.rows.map((row) => [
          row.dimensions.account ?? "",
          row.totals.inputTokens + row.totals.outputTokens,
        ]),
      );
    },
  });
  // Minute steps are enough for the bars; the card's countdowns read `now` themselves.
  const minute = Math.floor(now / 60_000);
  const limits = useMemo(
    () =>
      usageLimits(
        (accounts ?? []).map((account) => ({ account, environment: "This machine" })),
        minute * 60_000,
      ),
    [accounts, minute],
  );
  const headroom = useMemo(() => usageHeadroom(limits), [limits]);
  const [measure] = useRailMeasure();
  const [pins] = useRailPins();
  const rail = useMemo(
    () => railUsage(limits, used.data, measure, pins),
    [limits, used.data, measure, pins],
  );
  return { headroom, rail, observedAt, now };
}
