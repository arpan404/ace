import {
  formatTokens,
  ledgerChange,
  ledgerGroups,
  ledgerTop,
  nextLedgerGroup,
  unpricedLine,
  type LedgerFigure,
  type LedgerGroup,
  type LedgerLine,
  type LedgerStep,
} from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";

export type Metric = "cost" | "tokens";

const groupLabel = (group: LedgerGroup) =>
  ledgerGroups.find((entry) => entry.value === group)?.label ?? group;

/**
 * Spend as one ledger: the scope as crumbs (All / Claude / Work), a group to list it by, and one
 * row per value with its share, its days as a trend, its figure and its change against the span
 * before. A row narrows the scope to it and lists the level below; a thread row opens the thread.
 */
export function Ledger(props: {
  lines: readonly LedgerLine[] | undefined;
  loading: boolean;
  group: LedgerGroup;
  groups: readonly LedgerGroup[];
  onGroup(group: LedgerGroup): void;
  steps: readonly LedgerStep[];
  /** Keep the scope up to step `index`; -1 for all. */
  onCrumb(index: number): void;
  onStep(step: LedgerStep): void;
  metric: Metric;
  money(value: number): string;
  name(group: LedgerGroup, key: string): string;
  icon?(group: LedgerGroup, key: string): ReactNode;
}) {
  const [all, setAll] = useState(false);
  const { lines, group, metric } = props;
  const value = (figure: LedgerFigure) => (metric === "cost" ? figure.usd : figure.tokens);
  const top = Math.max(1e-9, ...(lines ?? []).map(value));
  const shown = all ? (lines ?? []) : (lines ?? []).slice(0, ledgerTop);
  return (
    <section aria-label="Spend by group">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-2">
        <nav aria-label="Scope" className="mr-auto flex flex-wrap items-center gap-x-1.5 text-ui">
          <Crumbs steps={props.steps} onCrumb={props.onCrumb} />
        </nav>
        <FilterMenu
          label="Group by"
          value={group}
          options={props.groups.map((each) => ({ value: each, label: groupLabel(each) }))}
          onValueChange={(next) => {
            setAll(false);
            props.onGroup(next);
          }}
        />
      </div>
      {/* Column names for the eye; each row's own name says its figures. */}
      <div aria-hidden className={cn(rowGrid, "h-8 text-xs text-subtle-foreground")}>
        <span>{groupLabel(group)}</span>
        <span className="hidden @min-[36rem]/usage:block">Share</span>
        <span className="hidden @min-[36rem]/usage:block">Each day</span>
        <span className="text-right">{metric === "cost" ? "Cost" : "Tokens"}</span>
        <span className="text-right">Change</span>
      </div>
      {lines === undefined ? (
        props.loading ? (
          <ListSkeleton label="spend" shape="row" rows={4} className="min-h-52" />
        ) : (
          <p className="py-3 text-ui text-subtle-foreground">Not recorded on these machines</p>
        )
      ) : lines.length === 0 ? (
        <p className="py-3 text-ui text-subtle-foreground">None in this period</p>
      ) : (
        <ul aria-label={`Spend by ${groupLabel(group).toLowerCase()}`}>
          {shown.map((line) => (
            <Row
              key={line.key}
              line={line}
              group={group}
              label={props.name(group, line.key)}
              icon={props.icon?.(group, line.key)}
              share={value(line) / top}
              metric={metric}
              money={props.money}
              onStep={props.onStep}
            />
          ))}
        </ul>
      )}
      {lines && lines.length > ledgerTop && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
          className="mt-1 rounded-xs py-1 text-xs text-subtle-foreground hover:text-foreground focus-ring"
        >
          {all ? "Show fewer" : `Show all ${lines.length}`}
        </button>
      )}
    </section>
  );
}

function Crumbs(props: { steps: readonly LedgerStep[]; onCrumb(index: number): void }) {
  const crumbs = [
    { label: "All", index: -1 },
    ...props.steps.map((step, index) => ({ label: step.label, index })),
  ];
  return crumbs.map((crumb, at) =>
    at === crumbs.length - 1 ? (
      <span key={crumb.index} aria-current="location" className="font-semibold">
        {crumb.label}
      </span>
    ) : (
      <span key={crumb.index} className="flex items-center gap-x-1.5">
        <button
          type="button"
          onClick={() => props.onCrumb(crumb.index)}
          className="rounded-xs text-muted-foreground hover:text-foreground hover:underline focus-ring"
        >
          {crumb.label}
        </button>
        <span aria-hidden className="text-faint-foreground">
          /
        </span>
      </span>
    ),
  );
}

/** Name · share · trend · figure · change; the share and trend fold away on a narrow page. */
const rowGrid = cn(
  "grid items-center gap-x-4 px-2 -mx-2",
  "grid-cols-[minmax(0,1fr)_auto_3.5rem]",
  "@min-[36rem]/usage:grid-cols-[minmax(0,1fr)_8rem_5.5rem_5.5rem_3.5rem]",
);

function Row(props: {
  line: LedgerLine;
  group: LedgerGroup;
  label: string;
  icon: ReactNode;
  share: number;
  metric: Metric;
  money(value: number): string;
  onStep(step: LedgerStep): void;
}) {
  const { line, metric } = props;
  const change = ledgerChange(line, metric);
  const figure =
    metric === "tokens"
      ? formatTokens(line.tokens)
      : unpricedLine(line)
        ? "Unpriced"
        : props.money(line.usd);
  const cells = (
    <>
      <span className="flex min-w-0 items-center gap-2.5 text-md">
        {props.icon}
        <span className="truncate">{props.label}</span>
      </span>
      <span aria-hidden className="hidden @min-[36rem]/usage:block">
        <span className="block h-1.5 rounded-full bg-faint-foreground/30">
          <span
            style={{ width: `${Math.max(2, props.share * 100)}%` }}
            className="block h-full rounded-full bg-muted-foreground"
          />
        </span>
      </span>
      <span aria-hidden className="hidden text-muted-foreground @min-[36rem]/usage:block">
        <Trend days={line.days} metric={metric} />
      </span>
      <span className="text-right text-md font-medium tabular-nums">{figure}</span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{change.label}</span>
    </>
  );
  const look = cn(
    rowGrid,
    "h-13 w-full rounded-md text-left shadow-[0_-1px_0_var(--border)] hover:bg-hover hover:shadow-none focus-ring-inset",
  );
  const name = `${props.label}: ${figure}${change.label ? `, ${change.label}` : ""}`;
  if (props.group === "thread")
    return (
      <li>
        <Link to="/t/$threadId" params={{ threadId: line.key }} aria-label={name} className={look}>
          {cells}
        </Link>
      </li>
    );
  if (!nextLedgerGroup(props.group))
    return (
      <li aria-label={name} className={look}>
        {cells}
      </li>
    );
  return (
    <li>
      <button
        type="button"
        aria-label={name}
        onClick={() => props.onStep({ group: props.group, key: line.key, label: props.label })}
        className={look}
      >
        {cells}
      </button>
    </li>
  );
}

/** The days as a filled line, scaled to the row's own busiest day. */
function Trend(props: { days: readonly LedgerFigure[]; metric: Metric }) {
  if (props.days.length < 2) return null;
  const values = props.days.map((day) => (props.metric === "cost" ? day.usd : day.tokens));
  const max = Math.max(1e-9, ...values);
  const points = values
    .map(
      (value, index) =>
        `${((index / (values.length - 1)) * 88).toFixed(1)},${(23 - (value / max) * 20).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg viewBox="0 0 88 24" className="block h-6 w-[88px]" aria-hidden>
      <polygon points={`0,24 ${points} 88,24`} className="fill-current opacity-15" />
      <polyline
        points={points}
        fill="none"
        className="stroke-current"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </svg>
  );
}
