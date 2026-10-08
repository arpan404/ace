import type { DiagnosticsHealth } from "@ace/protocol";
import { ArrowClockwiseIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { ToolbarButton } from "../terminal/toolbar.tsx";
import { ScopeMenu, useThreadAgents } from "./log-menus.tsx";

/*
 * The daemon scope. The daemon writes its log to files in its data directory and doesn't
 * stream it to apps (no `logs` read on the wire yet), so this leads with what it does report,
 * its health, refreshed while the tab shows, then offers the log folder's path.
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
      if (!reply.ok || !reply.health) throw new Error(reply.error ?? "ace didn't answer.");
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
        {health.data ? (
          <>
            <HealthTable health={health.data} />
            <LogFolder directory={health.data.logs.directory} />
          </>
        ) : health.isError ? (
          <EmptyState
            icon={WarningCircleIcon}
            title="Couldn't read ace's health"
            description={health.error.message}
            action={
              <Button size="sm" variant="outline" onClick={() => void health.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <ListSkeleton label="ace's health" shape="row" rows={5} className="max-w-[640px]" />
        )}
      </div>
    </div>
  );
}

/**
 * Where the log itself is, in one quiet line under the health it leads with: the daemon
 * doesn't stream its log to apps yet, so this offers its folder and the support bundle.
 */
function LogFolder(props: { directory: string | undefined }) {
  const toast = useToast();
  const copy = (path: string) =>
    navigator.clipboard.writeText(path).then(
      () => toast.add({ title: "Copied the log folder's path" }),
      () => toast.error({ title: "Couldn't copy", description: path }),
    );
  return (
    <div className="mt-4 flex max-w-[640px] flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
      <span>ace's own log isn't streamed yet.</span>
      {props.directory && (
        <Button
          size="sm"
          variant="ghost"
          title={props.directory}
          onClick={() => props.directory && void copy(props.directory)}
        >
          <CopyIcon aria-hidden size={14} />
          Copy log folder path
        </Button>
      )}
      <span>
        <code className="rounded-xs bg-muted px-1 font-mono">ace support-bundle</code> collects it.
      </span>
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
    <dl className="grid max-w-[640px] grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-6 font-mono text-sm leading-5">
      {rows.map(([label, value, warn]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={warn ? "text-status-failed" : "text-foreground"}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
