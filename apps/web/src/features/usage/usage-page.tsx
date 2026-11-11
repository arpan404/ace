import { ArrowsClockwiseIcon, ChartBarIcon, DevicesIcon } from "@phosphor-icons/react";
import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import {
  catalogModelIds,
  catalogModelNames,
  dayRange,
  formatAgo,
  formatTokens,
  growthSentence,
  ledgerGroupFor,
  ledgerScope,
  openLedgerGroups,
  previousSpan,
  priceNote,
  tokenTable,
  usagePercent,
  usageAccounts,
  usageDay,
  usageLimits,
  usageMoney,
  usageReport,
  type AccountLimits,
  type LedgerGroup,
  type LedgerStep,
  type MachineAccounts,
  type UsageReport,
} from "@ace/ui-core";
import { ProviderKind } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { primaryMachineId, useMachines, type Machine } from "@/lib/machines.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { listAutomations } from "@/features/automation-data/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { LimitsView } from "./limits-view.tsx";
import { breakdownNamer, withCanonicalModels } from "./breakdown-lists.ts";
import { Ledger, type Metric } from "./ledger.tsx";
import { useLedger } from "./ledger-data.ts";
import { TokensSection } from "./tokens-section.tsx";
import {
  accountsCoverage,
  useEnvironmentAccounts,
  useEnvironmentUsage,
  useRefreshUsage,
  type UsageSpan,
} from "./usage-data.ts";
import { SectionHeading } from "./usage-parts.tsx";

type Range = "1" | "7" | "30" | "90";
const ranges = [
  { value: "1", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const satisfies readonly { value: Range; label: string }[];
const periods: Record<Range, string> = {
  "1": "today",
  "7": "last 7 days",
  "30": "last 30 days",
  "90": "last 90 days",
};
const metrics = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const satisfies readonly { value: Metric; label: string }[];
const all = "all";

const readTitles = (reader: SidebarReader) =>
  new Map(
    reader.ids.flatMap((id) => {
      const title = reader.thread(id)?.title;
      return title ? [[id, title] as const] : [];
    }),
  );
const sameTitles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([id, title]) => b.get(id) === title);

/**
 * Usage (`/usage`): Limits as availability on one timeline, then Spend as one ledger to drill
 * into. Clicking an account's band drills Spend into that account; the scope's provider or
 * account also narrows Limits to it.
 */
export function UsagePage() {
  const now = useNow();
  const zone = useUsageTimeZone();
  const [range, setRange] = useState<Range>("30");
  const [metric, setMetric] = useState<Metric>("cost");
  const [environmentId, setEnvironmentId] = useState<string>(all);
  const [steps, setSteps] = useState<readonly LedgerStep[]>([]);
  const [group, setGroup] = useState<LedgerGroup>("provider");
  const [tokenTypes, setTokenTypes] = useState(false);
  const machines = useMachines();
  const scope = useMemo(() => ledgerScope(steps), [steps]);
  // Offline machines stay in scope so the coverage line names them; nothing reads from them.
  const environments = machines.filter(
    (machine) => environmentId === all || machine.id === environmentId,
  );
  const spending = environments.filter(
    (machine) => scope.machine === undefined || machine.id === scope.machine,
  );
  const online = environments.filter((machine) => machine.client !== undefined);
  const accounts = useEnvironmentAccounts(environments);
  const limitsCoverage = accountsCoverage(accounts);
  const span: UsageSpan = {
    from: usageDay(now, zone.timeZone, Number(range) - 1),
    to: usageDay(now, zone.timeZone),
    ready: zone.ready,
  };
  const usage = useEnvironmentUsage(spending, span, scope.filters);
  const ledger = useLedger(spending, span, scope.filters, group);
  const refresh = useRefreshUsage(online);
  const catalog = useModelCatalog();
  const modelName = useMemo(() => catalogModelNames(catalog ?? []), [catalog]);
  const modelId = useMemo(() => catalogModelIds(catalog ?? []), [catalog]);
  const project = useProjectName();
  const titles = useSidebarAll(readTitles, sameTitles);
  const automations = useDaemonQuery({
    queryKey: ["usage-page", "automations"],
    staleTime: 5 * 60_000,
    read: (client, signal) => listAutomations(client, signal),
  });
  // This machine keeps one id while its host id is learnt, so its rows (and an open banked-reset
  // dialog) aren't replaced when it arrives.
  const machineAccounts: MachineAccounts[] = accounts.map((entry) => ({
    id: entry.environment.primary ? primaryMachineId : entry.environment.id,
    name: entry.environment.name,
    // An offline machine's last accounts aren't counted: the coverage line names it instead.
    accounts: entry.environment.client ? entry.accounts : undefined,
  }));
  // Limits follow the scope's provider and account; its other steps are about spend only.
  const scopedProvider = scope.filters.provider?.[0];
  const scopedAccount = scope.filters.account?.[0];
  const listed = usageAccounts(machineAccounts, scopedProvider).filter(
    (entry) => scopedAccount === undefined || entry.account.id === scopedAccount,
  );
  const limits = usageLimits(listed, now);
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
  // One money format for the page, to the scale of the period's total.
  const money = usageMoney(report?.usd ?? 0);
  const prices = priceNote(usage.data?.machines.map((read) => read.prices) ?? []);
  const read = useMemo(
    () =>
      withCanonicalModels(
        usage.data?.machines ?? [],
        (owner, model) => modelId(owner, model) ?? model,
      ),
    [usage.data, modelId],
  );
  const namer = breakdownNamer({
    machines: read,
    accounts: listed.map((entry) => entry.account),
    machineList: machines,
    project,
    automation: (id) =>
      [...(automations.data?.person ?? []), ...(automations.data?.threads ?? [])].find(
        (entry) => entry.automation.id === id,
      )?.automation.title,
    modelName,
  });
  const name = (kind: LedgerGroup, key: string) =>
    kind === "thread" ? (titles?.get(key) ?? "Thread") : kind === "skill" ? key : namer(kind, key);
  const icon = (kind: LedgerGroup, key: string) => {
    const provider =
      kind === "provider"
        ? key
        : kind === "account"
          ? listed.find((entry) => entry.account.id === key)?.account.provider
          : undefined;
    const parsed = ProviderKind.safeParse(provider);
    return parsed.success ? <ProviderIcon provider={parsed.data} size={16} decorative /> : null;
  };
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
  const machineFor = (id: string | undefined): Machine | undefined =>
    machines.find((machine) => (id === primaryMachineId ? machine.primary : machine.id === id));
  const scopeTo = (next: readonly LedgerStep[]) => {
    setSteps(next);
    setGroup(ledgerGroupFor(next));
  };
  const showAccount = (entry: AccountLimits) =>
    scopeTo([
      { group: "provider", key: entry.account.provider, label: entry.account.providerLabel },
      { group: "account", key: entry.account.id, label: entry.account.label },
    ]);
  const value = (figure: { usd: number; tokens: number }) =>
    metric === "cost" ? money(figure.usd) : formatTokens(figure.tokens);
  const change =
    report && previous
      ? growthSentence(
          metric === "cost" ? report.usd : report.tokens,
          metric === "cost" ? previous.usd : previous.tokens,
          Number(range),
        )
      : undefined;
  return (
    <Screen title="Usage">
      <div className="h-full overflow-auto">
        <div
          className="@container/usage mx-auto px-4 pt-6 pb-20 sm:px-10"
          style={{ maxWidth: 960 }}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h2 className="mr-auto text-2xl leading-8 font-semibold tracking-title">Usage</h2>
            <FilterMenu
              label="Machine"
              value={environmentId}
              options={[
                {
                  value: all,
                  label: "All machines",
                  icon: <DevicesIcon size={16} className="text-subtle-foreground" />,
                },
                ...machines.map((machine) => ({
                  value: machine.id,
                  label: machine.name,
                  icon: (
                    <MachineMark
                      icon={machine.icon}
                      primary={machine.primary}
                      size={16}
                      decorative
                    />
                  ),
                })),
              ]}
              onValueChange={setEnvironmentId}
            />
          </div>
          {/* The machine filter names what is shown; only a machine left out is worth a line. */}
          {machines.length > 1 && !usage.coverage.complete && (
            <p
              aria-live="polite"
              data-testid="usage-coverage"
              className="mt-2 text-xs text-foreground"
            >
              {usage.coverage.line}
            </p>
          )}
          <SectionHeading id="usage-limits" title="Limits">
            {observedAt > 0 && <span>Read {formatAgo(observedAt, now)}</span>}
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
              <ListSkeleton label="limits" shape="row" rows={3} className="min-h-48" />
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
                onAccount={showAccount}
                redeem={async (entry, idempotencyKey) => {
                  const machine = machineFor(entry.environmentId);
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
          <SectionHeading id="usage-spend" title="Spend">
            <SegmentedControl
              label="Range"
              size="sm"
              value={range}
              options={ranges}
              onValueChange={(next) => setRange(next)}
            />
            <SegmentedControl
              label="Show"
              size="sm"
              value={metric}
              options={metrics}
              onValueChange={(next) => setMetric(next)}
            />
          </SectionHeading>
          <section aria-labelledby="usage-spend">
            {usage.error ? (
              <Failed error={usage.error} retry={usage.retry} />
            ) : !report ? (
              <ListSkeleton label="usage" shape="row" rows={6} className="min-h-80" />
            ) : (
              <>
                <p
                  data-testid="usage-total"
                  className="mb-5 flex flex-wrap items-baseline gap-x-2.5"
                >
                  <span className="text-3xl leading-10 font-semibold tracking-title tabular-nums">
                    {value(report)}
                  </span>
                  <span className="text-ui text-muted-foreground">
                    {[steps.at(-1)?.label, periods[range]].filter(Boolean).join(", ")}
                    {change ? `. ${change}` : ""}
                  </span>
                </p>
                <Ledger
                  lines={ledger.lines}
                  loading={ledger.loading}
                  group={group}
                  groups={openLedgerGroups(steps)}
                  onGroup={setGroup}
                  steps={steps}
                  onCrumb={(index) => scopeTo(steps.slice(0, index + 1))}
                  onStep={(step) => scopeTo([...steps, step])}
                  metric={metric}
                  money={money}
                  name={name}
                  icon={icon}
                />
                <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3.5 text-ui tabular-nums">
                  <span>{formatTokens(report.tokens)} tokens</span>
                  <CacheLine report={report} money={money} />
                  {prices && metric === "cost" && (
                    <span className="text-xs text-subtle-foreground">{prices}</span>
                  )}
                  <button
                    type="button"
                    aria-expanded={tokenTypes}
                    onClick={() => setTokenTypes((open) => !open)}
                    className="ml-auto rounded-xs font-medium hover:underline focus-ring"
                  >
                    {tokenTypes ? "Hide token types" : "Token types"}
                  </button>
                </div>
                {tokenTypes && (
                  <TokensSection
                    report={report}
                    period={periods[range]}
                    money={money}
                    prices={prices}
                  />
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </Screen>
  );
}

/** "71% of input came from cache, saving $3,410": what the cache did, when there was input. */
function CacheLine(props: { report: UsageReport; money(value: number): string }) {
  const table = tokenTable(props.report);
  if (table.cacheHitRate <= 0) return null;
  return (
    <span className="text-muted-foreground">
      {usagePercent(table.cacheHitRate)} of input came from cache
      {table.cacheSavingsUsd > 0 && (
        <>
          , saving <span className="text-status-done">{props.money(table.cacheSavingsUsd)}</span>
        </>
      )}
    </span>
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
