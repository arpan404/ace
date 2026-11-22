import { spadeSearchUsageLine } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { readSearchUsage } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/**
 * One quiet sentence under Spade's spending: this month's ace searches against the allowance,
 * or that signing in to ace lets bots search the web (ADR 0210 §6). Nothing while it loads, when
 * the read fails, or when Spade can't say.
 */
export function SearchUsageLine(props: { ready: boolean }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const usage = useQuery({
    queryKey: ["spade", "search-usage", machine],
    queryFn: ({ signal }) => readSearchUsage(client, { signal }),
    enabled: props.ready,
    // Searches count up as bots work.
    refetchInterval: 60_000,
  });
  const line = spadeSearchUsageLine(usage.data ?? undefined);
  if (!line) return null;
  return <p className="text-ui text-muted-foreground tabular-nums">{line}</p>;
}
