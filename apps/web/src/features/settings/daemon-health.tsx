import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";

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
const ms = (value: number | null) => (value === null ? "–" : `${value.toFixed(1)} ms`);

/**
 * The daemon's health: a key/value list, its queues, and Copy (the report as JSON, for a bug
 * report). Loads as a skeleton; a failed read says so with Try again.
 */
export function DaemonHealth() {
  const client = useClient();
  const connection = useDaemonConnection();
  const toast = useToast();
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
  if (health.isPending) return <ListSkeleton label="daemon health" shape="row" rows={3} />;
  if (health.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-muted-foreground">
        Couldn't read daemon health.
        <Button size="sm" variant="ghost" onClick={() => void health.refetch()}>
          Try again
        </Button>
      </div>
    );
  const data = health.data;
  const copy = () => {
    const report = JSON.stringify({ url: connection.url, health: data }, null, 2);
    const copied = navigator.clipboard?.writeText(report) ?? Promise.reject(new Error());
    void copied.then(
      () => toast.add({ title: "Diagnostics copied" }),
      () => toast.error({ title: "Couldn't copy the diagnostics" }),
    );
  };
  const rows: [string, string][] = [
    ["Socket", connection.url],
    ["Memory", mb(data.memory.rssBytes)],
    ["Heap", `${mb(data.memory.heapUsedBytes)} of ${mb(data.memory.heapTotalBytes)}`],
    ["Sessions", data.activeSessions === null ? "–" : String(data.activeSessions)],
    ["Event loop", `p99 ${ms(data.eventLoop.p99Ms)} · max ${ms(data.eventLoop.maxMs)}`],
    ["Open handles", String(data.openHandles)],
  ];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <DataTable caption="Daemon queues" columns={columns} data={queues} empty="No queues." />
      <div>
        <Button size="sm" variant="ghost" onClick={copy}>
          Copy diagnostics
        </Button>
      </div>
    </div>
  );
}
