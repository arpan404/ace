import { ArrowsClockwiseIcon, ChartBarIcon, XIcon } from "@phosphor-icons/react";
import { ManagedAccountProvider } from "@ace/protocol/accounts";
import {
  catalogModelIds,
  catalogModelNames,
  dayRange,
  formatAgo,
  growthBasis,
  previousSpan,
  tightestProvider,
  usageAccounts,
  usageDay,
  usageHeadroom,
  usageLimits,
  usageNow,
  usageQueryFilters,
  usageReport,
  usageSuggestion,
  type MachineAccounts,
  type UsageFilter,
  type UsageSuggestion,
} from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useMachines } from "@/lib/machines.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { listAutomations } from "@/features/automation-data/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { breakdownLists, breakdownNamer } from "./breakdown-lists.ts";
import { LimitsView } from "./limits-view.tsx";
import { NowLine } from "./now-line.tsx";
import { SpendSection, type Metric } from "./spend-section.tsx";
import { TokensSection } from "./tokens-section.tsx";
import {
  accountsCoverage,
  useEnvironmentAccounts,
  useEnvironmentUsage,
  useRefreshUsage,
  type UsageSpan,
} from "./usage-data.ts";
import { SectionHeading } from "./usage-parts.tsx";
import { WhereItWent } from "./where-it-went.tsx";

type Range = "1" | "30" | "90";
const ranges = [
  { value: "1", label: "Today" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const satisfies readonly { value: Range; label: string }[];
const periods: Record<Range, string> = { "1": "Today", "30": "Last 30 days", "90": "Last 90 days" };
const all = "all";

/**
 * Usage (`/usage`), one page top to bottom: Now (who has room, who is out), Limits per provider
 * and account, Spend, Tokens and Where it went. A row in Where it went (or a provider in the
 * legend) narrows the whole page to it through the usage queries' own filters.
 */
export function UsagePage() {
  const now = useNow();
  const zone = useUsageTimeZone();
  const [range, setRange] = useState<Range>("30");
  const [metric, setMetric] = useState<Metric>("cost");
  const [environmentId, setEnvironmentId] = useState<string>(all);
  const [filter, setFilter] = useState<UsageFilter>();
  const machines = useMachines();
  // Offline machines stay in scope so the coverage line names them; nothing reads from them.
  const environments = machines.filter(
    (machine) => environmentId === all || machine.id === environmentId,
  );
  const online = environments.filter((machine) => machine.client !== undefined);
  const accounts = useEnvironmentAccounts(environments);
  const limitsCoverage = accountsCoverage(accounts);
  const span: UsageSpan = {
    from: usageDay(now, zone.timeZone, Number(range) - 1),
    to: usageDay(now, zone.timeZone),
    ready: zone.ready,
  };
  const queryFilters = useMemo(() => usageQueryFilters(filter), [filter]);
  const usage = useEnvironmentUsage(environments, span, queryFilters);
  const refresh = useRefreshUsage(online);
  const catalog = useModelCatalog();
  const modelName = useMemo(() => catalogModelNames(catalog ?? []), [catalog]);
  const modelId = useMemo(() => catalogModelIds(catalog ?? []), [catalog]);
  const project = useProjectName();
  const automations = useDaemonQuery({
    queryKey: ["usage-page", "automations"],
    staleTime: 5 * 60_000,
    read: (client, signal) => listAutomations(client, signal),
  });
  const machineAccounts: MachineAccounts[] = accounts.map((entry) => ({
    id: entry.environment.id,
    name: entry.environment.name,
    // An offline machine's last accounts aren't counted: the coverage line names it instead.
    accounts: entry.environment.client ? entry.accounts : undefined,
  }));
  // Limits follow a provider or account filter; the other filters are about spend only.
  const listed = usageAccounts(
    machineAccounts,
    filter?.kind === "provider" ? filter.key : undefined,
  ).filter((entry) => filter?.kind !== "account" || entry.account.id === filter.key);
  const limits = usageLimits(listed, now);
  const headroom = usageHeadroom(limits);
  const nowLine = usageNow(headroom, now);
  const suggestion = usageSuggestion(headroom, tightestProvider(headroom)?.key);
  const days = useMemo(() => dayRange(span.from, span.to), [span.from, span.to]);
  const report = useMemo(
    () =>
      usage.data &&
      usageReport(usage.data.current, days, (owner, model) => modelId(owner, model) ?? model),
    [usage.data, days, modelId],
  );
  const previous = useMemo(() => {
    if (!usage.data) return undefined;
    const before = previousSpan(span.from, span.to);
    return usageReport(usage.data.previous, dayRange(before.from, before.to));
  }, [usage.data, span.from, span.to]);
  const lists = useMemo(() => usage.data && breakdownLists(usage.data.machines), [usage.data]);
  const name = breakdownNamer({
    machines: usage.data?.machines ?? [],
    accounts: listed.map((entry) => entry.account),
    machineList: machines,
    project,
    automation: (id) =>
      [...(automations.data?.person ?? []), ...(automations.data?.threads ?? [])].find(
        (entry) => entry.automation.id === id,
      )?.automation.title,
    modelName,
  });
  const accountsLoaded = !limitsCoverage.missing.some((entry) => entry.reach === "loading");
  // Nothing to list only when no machine's accounts could be read.
  const accountsFailed =
    limitsCoverage.counted === 0
      ? accounts.find((entry) => entry.error && !entry.accounts)?.error
      : undefined;
  const observedAt = Math.max(
    0,
    ...listed.flatMap((entry) => [
      entry.account.quota.observedAt,
      ...entry.account.windows.map((window) => window.observedAt ?? 0),
    ]),
  );
  const applyFilter = (next: UsageFilter) => {
    if (next.kind === "machine") {
      setEnvironmentId(next.key);
      return;
    }
    setFilter((current) =>
      current?.kind === next.kind && current.key === next.key ? undefined : next,
    );
  };
  const makeDefault = async (pick: UsageSuggestion) => {
    const provider = ManagedAccountProvider.safeParse(pick.provider);
    const machine = machines.find((candidate) => candidate.id === pick.account.environmentId);
    if (!provider.success || !machine?.client) throw new Error("Can't change this default");
    await machine.client.request({
      type: "accounts.setDefault",
      provider: provider.data,
      instanceId: pick.account.account.id,
    });
    await refresh();
  };
  const canDefault =
    suggestion !== undefined &&
    ManagedAccountProvider.safeParse(suggestion.provider).success &&
    machines.some(
      (machine) => machine.id === suggestion.account.environmentId && machine.client !== undefined,
    );
  return (
    <Screen title="Usage">
      <div className="h-full overflow-auto">
        <div className="mx-auto px-4 pt-6 pb-20 sm:px-10" style={{ maxWidth: 960 }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="mr-auto text-2xl font-semibold tracking-[-0.015em]">Usage</h1>
            <FilterMenu
              label="Machine"
              value={environmentId}
              options={[
                { value: all, label: "All machines" },
                ...machines.map((machine) => ({ value: machine.id, label: machine.name })),
              ]}
              onValueChange={setEnvironmentId}
            />
            <SegmentedControl
              label="Range"
              size="sm"
              value={range}
              options={ranges}
              onValueChange={(next) => setRange(next)}
            />
          </div>
          {machines.length > 1 && (
            <p
              aria-live="polite"
              data-testid="usage-coverage"
              className={`mt-2 min-h-4 text-xs ${usage.coverage.complete ? "text-subtle-foreground" : "text-foreground"}`}
            >
              {usage.coverage.line}
            </p>
          )}
          {filter && (
            <p className="mt-3 flex items-center gap-2 text-ui text-muted-foreground">
              Showing {filter.label} only
              <button
                type="button"
                onClick={() => setFilter(undefined)}
                className="inline-flex items-center gap-1 rounded-xs text-foreground hover:underline focus-ring"
              >
                <XIcon size={12} aria-hidden />
                Clear
              </button>
            </p>
          )}
          <div className="mt-5">
            <NowLine
              line={nowLine}
              suggestion={suggestion}
              act={canDefault ? makeDefault : undefined}
            />
          </div>
          <SectionHeading id="usage-limits" title="Limits">
            {observedAt > 0 && <span>Updated {formatAgo(observedAt, now)}</span>}
            <button
              type="button"
              aria-label="Refresh limits"
              onClick={() => void refresh()}
              className="grid size-6 place-items-center rounded-sm text-subtle-foreground hover:bg-hover hover:text-foreground focus-ring"
            >
              <ArrowsClockwiseIcon size={14} aria-hidden />
            </button>
          </SectionHeading>
          <div aria-labelledby="usage-limits" role="region">
            {accountsFailed ? (
              <Failed error={accountsFailed} retry={() => void refresh()} />
            ) : !accountsLoaded ? (
              <ListSkeleton label="limits" shape="row" rows={4} className="min-h-48" />
            ) : listed.length === 0 && !limitsCoverage.complete ? (
              <EmptyState
                icon={ChartBarIcon}
                title="No limits could be read"
                description={limitsCoverage.line ?? undefined}
              />
            ) : listed.length === 0 ? (
              <EmptyState
                icon={ChartBarIcon}
                title="No accounts yet"
                description="Add an account to see its limits."
                action={
                  <Button size="sm" render={<Link to="/settings/providers" />}>
                    Add account
                  </Button>
                }
              />
            ) : (
              <LimitsView
                limits={limits}
                now={now}
                redeem={async (entry, idempotencyKey) => {
                  const machine = environments.find(
                    (candidate) => candidate.id === entry.environmentId,
                  );
                  if (!machine?.client) throw new Error("Machine is offline");
                  const reply = await machine.client.request({
                    type: "accounts.consumeReset",
                    instanceId: entry.account.id,
                    idempotencyKey,
                  });
                  await refresh();
                  return reply.outcome;
                }}
              />
            )}
          </div>
          {usage.error ? (
            <div className="mt-10">
              <Failed error={usage.error} retry={usage.retry} />
            </div>
          ) : !report || !lists ? (
            <ListSkeleton label="usage" shape="row" rows={6} className="mt-10 min-h-80" />
          ) : (
            <>
              <SpendSection
                report={report}
                previous={previous}
                period={periods[range]}
                basis={growthBasis(Number(range))}
                metric={metric}
                onMetric={setMetric}
                providerName={(id) => name("provider", id)}
                onProvider={(id) =>
                  applyFilter({ kind: "provider", key: id, label: name("provider", id) })
                }
              />
              <TokensSection report={report} period={periods[range]} />
              <WhereItWent
                lists={lists}
                metric={metric}
                name={name}
                current={filter}
                onFilter={applyFilter}
              />
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

function Failed(props: { error: Error; retry(): void }) {
  return (
    <EmptyState
      icon={ChartBarIcon}
      title="Couldn't load usage"
      description={describeDaemonError(daemonErrorCode(props.error))}
      action={
        <Button size="sm" onClick={props.retry}>
          Try again
        </Button>
      }
    />
  );
}
