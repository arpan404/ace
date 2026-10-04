import { ThreadId, UsageQuery, UsageSessionTotalsQuery } from "@ace/protocol";
import {
  dayStart,
  formatApiPrice,
  formatTokens,
  formatUsd,
  sessionCost,
  usageCost,
  usageDay,
} from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";

/** The past year: today and 364 days before, inside the longest span a usage query covers. */
const yearDays = 364;
/** Snapshot rows one `usage.session_totals` read returns at most. */
const pageRows = 100;

/**
 * The thread's tokens and cost over the past year (in the daemon's calendar): its usage rows, and
 * the provider sessions it ran that were active in that year (Claude reports cost per session,
 * OpenCode per step). `partial` when the thread has more snapshots than one read returns.
 */
function useThreadCost(threadId: string) {
  const now = useNow();
  const zone = useUsageTimeZone();
  const from = usageDay(now, zone.timeZone, yearDays);
  const to = usageDay(now, zone.timeZone);
  return useDaemonQuery({
    queryKey: ["usage", "thread", threadId, from, to, zone.timeZone ?? ""],
    enabled: zone.ready,
    staleTime: 15_000,
    read: async (client, signal) => {
      const thread = ThreadId.parse(threadId);
      const query = UsageQuery.parse({
        from,
        to,
        filters: { thread: [thread] },
        equivalentApiCost: true,
      });
      const [summary, sessions] = await Promise.all([
        client.request({ type: "usage.summary", query }, { signal }),
        client
          .request(
            {
              type: "usage.session_totals",
              query: UsageSessionTotalsQuery.parse({ thread, limit: pageRows }),
            },
            { signal },
          )
          .then((reply) => reply.totals),
      ]);
      const since = dayStart(from, zone.timeZone);
      return {
        cost: usageCost(
          summary.result.rows,
          sessionCost(sessions.filter((total) => total.at >= since)),
        ),
        partial: sessions.length >= pageRows,
      };
    },
  });
}

/** "Past year: 1.2M tokens · $0.08 reported", else the API-price estimate, else unavailable. */
export function ThreadUsage(props: { threadId: string }) {
  const usage = useThreadCost(props.threadId);
  if (usage.isError) return <span>Thread cost unavailable</span>;
  if (!usage.data) return <span>Reading the thread's cost…</span>;
  const { tokens, reported, apiPrice } = usage.data.cost;
  const price =
    reported > 0
      ? `${usage.data.partial ? "at least " : ""}${formatUsd(reported)} reported`
      : apiPrice === null
        ? "cost unavailable"
        : `${formatApiPrice(apiPrice)} at API prices`;
  return (
    <span>
      Past year: {formatTokens(tokens)} tokens · {price}
    </span>
  );
}
