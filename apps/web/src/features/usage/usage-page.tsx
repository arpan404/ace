import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import {
  catalogModelIds,
  catalogModelNames,
  dayRange,
  growthBasis,
  previousSpan,
  providerNames,
  usageAccountProviders,
  usageAccounts,
  usageDay,
  usageLimits,
  usageReport,
  type MachineAccounts,
} from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useMachines } from "@/lib/machines.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { Screen } from "@/features/shell/index.ts";
import { LimitsView } from "./limits-view.tsx";
import { SpendView } from "./spend-view.tsx";
import {
  accountsCoverage,
  useEnvironmentAccounts,
  useEnvironmentUsage,
  useRefreshUsage,
  type UsageSpan,
} from "./usage-data.ts";

type View = "cost" | "tokens" | "limits";
type Range = "1" | "7" | "30" | "90";
const views = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: View; label: string }[];
const ranges = [
  { value: "1", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const satisfies readonly { value: Range; label: string }[];
const all = "all";

const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

/**
 * Usage (`/usage`): Cost, Tokens and Limits over the environments and providers chosen. Limits
 * always say what is left; money is the API estimate and never prices a model ace can't.
 */
export function UsagePage() {
  const now = useNow();
  const zone = useUsageTimeZone();
  const [view, setView] = useState<View>("limits");
  const [range, setRange] = useState<Range>("30");
  const [environmentId, setEnvironmentId] = useState<string>(all);
  const [provider, setProvider] = useState<string>(all);
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
  const usage = useEnvironmentUsage(environments, span, provider === all ? undefined : [provider]);
  const refresh = useRefreshUsage(online);
  const catalog = useModelCatalog();
  const modelName = useMemo(() => catalogModelNames(catalog ?? []), [catalog]);
  const modelId = useMemo(() => catalogModelIds(catalog ?? []), [catalog]);
  const machineAccounts: MachineAccounts[] = accounts.map((entry) => ({
    id: entry.environment.id,
    name: entry.environment.name,
    // An offline machine's last accounts aren't counted: the coverage line names it instead.
    accounts: entry.environment.client ? entry.accounts : undefined,
  }));
  const listed = usageAccounts(machineAccounts, provider === all ? undefined : provider);
  const providerOptions = [
    { value: all, label: "All providers" },
    ...usageAccountProviders(machineAccounts).map((id) => ({ value: id, label: providerName(id) })),
  ];
  const environmentOptions = [
    { value: all, label: "All environments" },
    ...machines.map((machine) => ({ value: machine.id, label: machine.name })),
  ];
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
  const accountsLoaded = !limitsCoverage.missing.some((entry) => entry.reach === "loading");
  // Nothing to list only when no machine's accounts could be read.
  const accountsFailed =
    limitsCoverage.counted === 0
      ? accounts.find((entry) => entry.error && !entry.accounts)?.error
      : undefined;
  const coverage = view === "limits" ? limitsCoverage : usage.coverage;
  return (
    <Screen title="Usage">
      <div className="h-full overflow-auto">
        <div className="mx-auto px-4 pt-4 pb-20 sm:px-8" style={{ maxWidth: 1040 }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <nav aria-label="Usage filters" className="flex min-w-0 items-center gap-0.5">
              <FilterMenu
                label="Environment"
                value={environmentId}
                options={environmentOptions}
                onValueChange={setEnvironmentId}
              />
              <span aria-hidden className="text-subtle-foreground">
                /
              </span>
              <FilterMenu
                label="Provider"
                value={provider}
                options={providerOptions}
                onValueChange={setProvider}
              />
            </nav>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SegmentedControl
                label="View"
                size="sm"
                value={view}
                options={views}
                onValueChange={(next) => setView(next)}
              />
              {view !== "limits" && (
                <SegmentedControl
                  label="Range"
                  size="sm"
                  value={range}
                  options={ranges}
                  onValueChange={(next) => setRange(next)}
                />
              )}
              <IconButton
                icon={ArrowsClockwiseIcon}
                label="Refresh"
                size="sm"
                onClick={() => void refresh()}
              />
            </div>
          </div>
          {machines.length > 1 && (
            <p
              aria-live="polite"
              data-testid="usage-coverage"
              className={`mt-3 min-h-4 text-xs ${coverage.complete ? "text-subtle-foreground" : "text-foreground"}`}
            >
              {coverage.line}
            </p>
          )}
          <div className="mt-8">
            {view === "limits" ? (
              accountsFailed ? (
                <Failed error={accountsFailed} retry={() => void refresh()} />
              ) : !accountsLoaded ? (
                <ListSkeleton label="limits" shape="row" rows={5} className="min-h-80" />
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
                  limits={usageLimits(listed, now)}
                  now={now}
                  redeem={async (entry, idempotencyKey) => {
                    const machine = environments.find(
                      (candidate) => candidate.id === entry.environmentId,
                    );
                    if (!machine?.client) throw new Error("Environment is offline");
                    const reply = await machine.client.request({
                      type: "accounts.consumeReset",
                      instanceId: entry.account.id,
                      idempotencyKey,
                    });
                    await refresh();
                    return reply.outcome;
                  }}
                />
              )
            ) : usage.error ? (
              <Failed error={usage.error} retry={usage.retry} />
            ) : !report ? (
              <ListSkeleton label="usage" shape="row" rows={6} className="min-h-80" />
            ) : (
              <SpendView
                report={report}
                previous={previous}
                basis={growthBasis(Number(range))}
                metric={view}
                providerName={providerName}
                modelName={modelName}
              />
            )}
          </div>
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
