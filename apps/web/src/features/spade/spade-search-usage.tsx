import { spadeSearchUsageLine } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { readSearchUsage } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/**
 * One quiet row inside Spade's Spending card: this month's ace searches against the allowance
 * with a thin progress meter, or that signing in to ace lets bots search the web (ADR 0210 §6).
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
  const data = usage.data ?? undefined;
  const line = spadeSearchUsageLine(data);
  if (!line) return null;
  const ratio =
    data && data.used !== null && data.allowance !== null && data.allowance > 0
      ? Math.min(1, data.used / data.allowance)
      : undefined;
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <p className="text-xs text-muted-foreground tabular-nums">{line}</p>
      {ratio !== undefined && (
        <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-foreground/35 transition-[width] duration-(--motion-base)"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
