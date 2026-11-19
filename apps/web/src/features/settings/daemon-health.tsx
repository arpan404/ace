import { useHostIdentity } from "@/lib/host-name.ts";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { healthRows, queueRows } from "@ace/ui-core/host-care";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";

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
  { accessorKey: "name", header: "Pending work" },
  { accessorKey: "depth", header: "Waiting" },
];

/**
 * The daemon's health: a key/value list, its queues, and Copy (the report as JSON, for a bug
 * report). Loads as a skeleton; a failed read says so with Try again.
 */
export function DaemonHealth() {
  const client = useClient();
  const identity = useHostIdentity();
  const host = identity?.displayName ?? "This machine";
  const toast = useToast();
  const report = useCopy(() => toast.error({ title: "Couldn't copy the diagnostics" }));
  const ready = useConnectionState() === "ready";
  const health = useQuery({
    ...daemonQueries.health(client),
    enabled: ready,
    refetchInterval: 15_000,
  });
  const queues = useMemo(() => (health.data ? queueRows(health.data) : []), [health.data]);
  if (!ready) return <p className="text-sm text-muted-foreground">Waiting for ace…</p>;
  if (health.isPending) return <ListSkeleton label="ace health" shape="row" rows={3} />;
  if (health.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-muted-foreground">
        Couldn't read ace health.
        <Button size="sm" variant="secondary" onClick={() => void health.refetch()}>
          Try again
        </Button>
      </div>
    );
  const data = health.data;
  // The machine this page reads, not this window's own: Settings may be editing another.
  const copy = () =>
    report.copy(JSON.stringify({ machine: host, hostId: identity?.hostId, health: data }, null, 2));
  const rows: [string, string][] = [["Machine", host], ...healthRows(data)];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate tabular-nums">
              {label === "Machine" ? <MachineLabel name={host} icon={identity?.icon} /> : value}
            </dd>
          </div>
        ))}
      </dl>
      <DataTable caption="Pending work" columns={columns} data={queues} empty="No queues." />
      <div>
        <Button size="sm" variant="secondary" onClick={copy}>
          {report.copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </div>
    </div>
  );
}
