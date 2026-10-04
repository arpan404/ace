import type { DiagnosticsHealth } from "@ace/protocol";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { ToolbarButton } from "../terminal/toolbar.tsx";
import { ScopeMenu, useThreadAgents } from "./log-menus.tsx";

/*
 * The daemon scope. The daemon writes its log to files in its data directory and doesn't
 * stream it to apps (no `logs` read on the wire yet), so this shows what it does report: its
 * health, refreshed while the tab shows, and says where the log itself is.
 */

/** Health is read again this often while the tab shows (and not while the page is hidden). */
const refreshMs = 5_000;

const bytes = (value: number | null) =>
  value === null
    ? "unknown"
    : value >= 1 << 30
      ? `${(value / (1 << 30)).toFixed(1)} GB`
      : value >= 1 << 20
        ? `${Math.round(value / (1 << 20))} MB`
        : `${Math.round(value / 1024)} KB`;
const ms = (value: number | null) => (value === null ? "unknown" : `${value.toFixed(1)} ms`);

export function DaemonLog(props: TabViewProps) {
  const agents = useThreadAgents(props.scope);
  const health = useDaemonQuery({
    queryKey: ["diagnostics", "health"],
    refetchInterval: refreshMs,
    read: async (client) => {
      const reply = await client.request({ type: "diagnostics.health" });
      if (!reply.ok || !reply.health) throw new Error(reply.error ?? "The daemon didn't answer.");
      return reply.health;
    },
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-1.5 shadow-[inset_0_-1px_0_var(--border)]">
        <ScopeMenu threadId={props.scope} tab={props.tab} agents={agents} />
        <span className="flex-1" />
        <ToolbarButton
          icon={ArrowClockwiseIcon}
          label="Read health again"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pt-3 pb-4">
        <p className="max-w-[64ch] text-ui leading-5 text-muted-foreground">
          The daemon keeps its log in the <code className="font-mono text-[12px]">logs</code> folder
          of its data directory, and{" "}
          <code className="font-mono text-[12px]">ace support-bundle</code> collects it. Showing it
          here needs the daemon to stream its log to apps, which it doesn't yet. Its health:
        </p>
        {health.data ? (
          <HealthTable health={health.data} />
        ) : health.isError ? (
          <EmptyState
            icon={WarningCircleIcon}
            title="Couldn't read the daemon's health"
            description={health.error.message}
            action={
              <Button size="sm" variant="outline" onClick={() => void health.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <ListSkeleton
            label="the daemon's health"
            shape="row"
            rows={5}
            className="mt-3 max-w-[640px]"
          />
        )}
      </div>
    </div>
  );
}

function HealthTable(props: { health: DiagnosticsHealth }) {
  const { health } = props;
  const queued = Object.entries(health.queues).filter(([, count]) => count > 0);
  const rows: [string, string, boolean?][] = [
    ["Event loop", `${ms(health.eventLoop.meanMs)} mean · ${ms(health.eventLoop.p99Ms)} p99`],
    [
      "Memory",
      `${bytes(health.memory.rssBytes)} resident · ${bytes(health.memory.heapUsedBytes)} heap`,
    ],
    ["Sessions", health.activeSessions === null ? "unknown" : String(health.activeSessions)],
    ["Open handles", String(health.openHandles)],
    [
      "Database",
      `${bytes(health.sqlite.pageBytes)} · ${bytes(health.sqlite.walBytes)} write-ahead log`,
    ],
    [
      "Queues",
      queued.length ? queued.map(([name, count]) => `${name} ${count}`).join(" · ") : "empty",
    ],
    [
      "Log writer",
      `${health.logs.queued} queued · ${health.logs.dropped} dropped · ${health.logs.failed} failed`,
      health.logs.dropped > 0 || health.logs.failed > 0,
    ],
  ];
  return (
    <dl className="mt-3 grid max-w-[640px] grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-6 font-mono text-[12px] leading-5">
      {rows.map(([label, value, warn]) => (
        <div key={label} className="contents">
          <dt className="text-subtle-foreground">{label}</dt>
          <dd className={warn ? "text-status-failed" : "text-muted-foreground"}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
