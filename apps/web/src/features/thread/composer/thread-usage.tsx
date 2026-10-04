import { ThreadId, UsageQuery, UsageSessionTotalsQuery } from "@ace/protocol";
import {
  formatApiPrice,
  formatTokens,
  formatUsd,
  sessionCost,
  usageCost,
  usageDay,
  type UsageCost,
} from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";

/** A year back from today, a day inside the longest span a usage query covers. */
const yearDays = 364;

/**
 * The whole thread's tokens and cost over the last year: its usage rows, and the running totals
 * of the provider sessions it ran (Claude reports cost per session, OpenCode per step).
 */
function useThreadCost(threadId: string) {
  const now = useNow();
  const from = usageDay(now, yearDays);
  const to = usageDay(now);
  return useDaemonQuery({
    queryKey: ["usage", "thread", threadId, to],
    staleTime: 15_000,
    read: async (client, signal): Promise<UsageCost> => {
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
              query: UsageSessionTotalsQuery.parse({ thread, limit: 100 }),
            },
            { signal },
          )
          .then((reply) => reply.totals),
      ]);
      return usageCost(summary.result.rows, sessionCost(sessions));
    },
  });
}

/** "Thread: 1.2M tokens · $0.08 reported", or the API-price estimate when nothing was reported. */
export function ThreadUsage(props: { threadId: string }) {
  const cost = useThreadCost(props.threadId);
  if (cost.isError) return <span>Thread cost unavailable</span>;
  if (!cost.data) return <span>Reading the thread's cost…</span>;
  const { tokens, reported, apiPrice } = cost.data;
  const price =
    reported > 0
      ? `${formatUsd(reported)} reported`
      : apiPrice === null
        ? "cost unavailable"
        : `${formatApiPrice(apiPrice)} at API prices`;
  return (
    <span>
      Thread: {formatTokens(tokens)} tokens · {price}
    </span>
  );
}
