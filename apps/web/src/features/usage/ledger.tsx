import { CaretRightIcon } from "@phosphor-icons/react";
import {
  formatTokens,
  ledgerChange,
  ledgerGroups,
  ledgerScope,
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
import type { Machine } from "@/lib/machines.ts";
import { useLedger } from "./ledger-data.ts";
import type { UsageSpan } from "./usage-data.ts";

export type Metric = "cost" | "tokens";

const groupLabel = (group: LedgerGroup) =>
  ledgerGroups.find((entry) => entry.value === group)?.label ?? group;
/** What every row of the ledger reads and draws with. */
interface LedgerContext {
  machines: readonly Machine[];
  span: UsageSpan;
  metric: Metric;
  money(value: number): string;
  /** A row's name; `parent` is the step it opened from, so an account under its provider can drop the provider's name. */
  name(group: LedgerGroup, key: string, parent: LedgerStep | undefined): string;
  icon?(group: LedgerGroup, key: string): ReactNode;
}

/**
 * Spend as one ledger, grouped by one dimension: a row per value with its share, its days as a
 * trend, its figure and its change against the span before. A row opens in place to what is
 * inside it, the level below (a provider's accounts, an account's projects, a project's threads),
 * each a share of its parent; the row stays put and nothing else on the page changes. A thread row
 * opens the thread.
 */
export function Ledger(
  props: LedgerContext & {
    lines: readonly LedgerLine[] | undefined;
    loading: boolean;
    group: LedgerGroup;
    onGroup(group: LedgerGroup): void;
    /** A row to open on arrival (an account chosen from Limits). */
    open?: string | undefined;
  },
) {
  const { lines, group } = props;
  return (
    <section aria-label="Spend by group">
      <div className="mb-1 flex items-center justify-end gap-x-1">
        <span aria-hidden className="text-xs text-subtle-foreground">
          Group by
        </span>
        <FilterMenu
          label="Group by"
          value={group}
          options={ledgerGroups.map((each) => ({ value: each.value, label: each.label }))}
          onValueChange={props.onGroup}
        />
      </div>
      {/* Column names for the eye; each row's own name says its figures. */}
      <div aria-hidden className={cn(rowGrid, "h-8 text-xs text-subtle-foreground")}>
        <span className="pl-6">{groupLabel(group)}</span>
        <span className="hidden @min-[36rem]/usage:block">Share</span>
        <span className="hidden @min-[36rem]/usage:block">Each day</span>
        <span className="text-right">{props.metric === "cost" ? "Cost" : "Tokens"}</span>
        <span className="text-right">Change</span>
      </div>
      <Rows
        {...props}
        // Remount when the grouping (or the row to open) changes, so no row stays open under a
        // different group.
        key={`${group}:${props.open ?? ""}`}
        lines={lines}
        group={group}
        path={[]}
        label={`Spend by ${groupLabel(group).toLowerCase()}`}
      />
    </section>
  );
}

/** One level of rows: the top of the ledger, or what one row opened to. */
function Rows(
  props: LedgerContext & {
    lines: readonly LedgerLine[] | undefined;
    loading: boolean;
    group: LedgerGroup;
    path: readonly LedgerStep[];
    label: string;
    open?: string | undefined;
  },
) {
  const [all, setAll] = useState(false);
  const { lines, metric } = props;
  const depth = props.path.length;
  const value = (figure: LedgerFigure) => (metric === "cost" ? figure.usd : figure.tokens);
  const whole = Math.max(
    1e-9,
    (lines ?? []).reduce((sum, line) => sum + value(line), 0),
  );
  const shown = all ? (lines ?? []) : (lines ?? []).slice(0, ledgerTop);
  const quiet = (text: string) => (
    <p
      style={{ paddingLeft: `${depth * 20 + 24}px` }}
      className="py-2.5 text-ui text-subtle-foreground"
    >
      {text}
    </p>
  );
  if (lines === undefined)
    return props.loading ? (
      <ListSkeleton
        label="spend"
        shape="row"
        rows={depth ? 2 : 4}
        className={depth ? "" : "min-h-52"}
      />
    ) : (
      quiet("Not recorded on these machines")
    );
  if (lines.length === 0) return quiet("None in this period");
  return (
    <>
      <ul aria-label={props.label}>
        {shown.map((line) => (
          <Row
            {...props}
            key={line.key}
            line={line}
            share={value(line) / whole}
            startOpen={props.open === line.key}
          />
        ))}
      </ul>
      {lines.length > ledgerTop && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
          style={{ marginLeft: `${depth * 20 + 24}px` }}
          className="mt-1 mb-1 rounded-xs py-1 text-xs text-subtle-foreground hover:text-foreground focus-ring"
        >
          {all ? "Show fewer" : `Show all ${lines.length}`}
        </button>
      )}
    </>
  );
}

/** What one row opened to: the level below it, within every step above it. */
function Children(
  props: LedgerContext & { path: readonly LedgerStep[]; group: LedgerGroup; label: string },
) {
  const scope = ledgerScope(props.path);
  const machines = props.machines.filter(
    (machine) => scope.machine === undefined || machine.id === scope.machine,
  );
  const read = useLedger(machines, props.span, scope.filters, props.group);
  return <Rows {...props} lines={read.lines} loading={read.loading} />;
}

/** Name · share · trend · figure · change; the share and trend fold away on a narrow page. */
const rowGrid = cn(
  "grid items-center gap-x-4 px-2 -mx-2",
  "grid-cols-[minmax(0,1fr)_auto_3.5rem]",
  "@min-[36rem]/usage:grid-cols-[minmax(0,1fr)_8rem_5.5rem_5.5rem_3.5rem]",
);

function Row(
  props: LedgerContext & {
    line: LedgerLine;
    group: LedgerGroup;
    path: readonly LedgerStep[];
    share: number;
    startOpen: boolean;
  },
) {
  const { line, metric, group } = props;
  const [open, setOpen] = useState(props.startOpen);
  const depth = props.path.length;
  const parent = props.path.at(-1);
  const label = props.name(group, line.key, parent);
  const next = nextLedgerGroup(group);
  const change = ledgerChange(line, metric);
  const figure =
    metric === "tokens"
      ? formatTokens(line.tokens)
      : unpricedLine(line)
        ? "Unpriced"
        : props.money(line.usd);
  const cells = (
    <>
      <span
        style={{ paddingLeft: `${depth * 20}px` }}
        className={cn("flex min-w-0 items-center gap-2 text-md", depth > 0 && "text-ui")}
      >
        <span
          aria-hidden
          className="grid size-4 shrink-0 place-items-center text-subtle-foreground"
        >
          {next && (
            <CaretRightIcon
              size={12}
              weight="bold"
              className={cn(
                "transition-transform duration-(--motion-fast) motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          )}
        </span>
        {props.icon?.(group, line.key)}
        <span className="truncate">{label}</span>
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
      <span
        className={cn("text-right tabular-nums", depth > 0 ? "text-ui" : "text-md font-medium")}
      >
        {figure}
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{change.label}</span>
    </>
  );
  const look = cn(
    rowGrid,
    "w-full rounded-md text-left shadow-[0_-1px_0_var(--border)] hover:bg-hover hover:shadow-none focus-ring-inset",
    depth > 0 ? "h-10" : "h-13",
  );
  const name = `${label}: ${figure}${change.label ? `, ${change.label}` : ""}`;
  if (group === "thread")
    return (
      <li>
        <Link to="/t/$threadId" params={{ threadId: line.key }} aria-label={name} className={look}>
          {cells}
        </Link>
      </li>
    );
  if (!next)
    return (
      <li aria-label={name} className={look}>
        {cells}
      </li>
    );
  const step: LedgerStep = { group, key: line.key, label };
  return (
    <li>
      <button
        type="button"
        aria-label={name}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={look}
      >
        {cells}
      </button>
      {open && (
        <Children
          {...props}
          path={[...props.path, step]}
          group={next}
          label={`${label} by ${groupLabel(next).toLowerCase()}`}
        />
      )}
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
