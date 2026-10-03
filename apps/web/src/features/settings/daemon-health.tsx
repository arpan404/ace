import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

/**
 * Request/response daemon reads go through TanStack Query, wrapping @ace/client request APIs.
 * Live thread, sidebar and agent state never enter the Query cache.
 */
export const daemonQueries = {
  health: (client: ClientApi) => ({
    queryKey: ["daemon", "health"] as const,
    queryFn: async () => {
      const result = await client.command({ type: "diagnostics.health" }, { timeoutMs: 10_000 });
      if (!result.ok || !result.health) throw new Error(result.error ?? "No health report");
      return result.health;
    },
  }),
};

interface QueueRow {
  name: string;
  depth: number;
}
const columns: DataColumns<QueueRow> = [
  { accessorKey: "name", header: "Queue" },
  { accessorKey: "depth", header: "Depth" },
];

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

export function DaemonHealth() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const health = useQuery({
    ...daemonQueries.health(client),
    enabled: ready,
    refetchInterval: 15_000,
  });
  const queues = useMemo(
    () => Object.entries(health.data?.queues ?? {}).map(([name, depth]) => ({ name, depth })),
    [health.data],
  );
  if (!ready) return <p className="text-sm text-muted-foreground">Waiting for the daemon…</p>;
  if (health.isPending) return <Spinner aria-label="Loading daemon health" />;
  if (health.isError)
    return (
      <p role="alert" className="text-sm text-status-failed">
        Couldn't read daemon health.
      </p>
    );
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <dt className="text-muted-foreground">Memory</dt>
        <dd>{mb(health.data.memory.rssBytes)}</dd>
        <dt className="text-muted-foreground">Sessions</dt>
        <dd>{health.data.activeSessions ?? "–"}</dd>
      </dl>
      <DataTable caption="Daemon queues" columns={columns} data={queues} empty="No queues." />
    </div>
  );
}
