import {
  breakdownKinds,
  breakdownTitles,
  breakdownTop,
  formatTokens,
  type BreakdownKind,
  type BreakdownLine,
  type UsageFilter,
  unpricedLine,
} from "@ace/ui-core";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { SectionHeading } from "./usage-parts.tsx";

/** One list's lines; undefined when no machine in scope records it. */
export type BreakdownLists = Partial<Record<BreakdownKind, readonly BreakdownLine[]>>;

/**
 * Where the period's usage went, one list per dimension: each shows its top five, "Show all"
 * opens its full ranking, and clicking a row filters the whole page to it.
 */
export function WhereItWent(props: {
  lists: BreakdownLists;
  metric: "cost" | "tokens";
  money(value: number): string;
  /** The row's name in words. */
  name(kind: BreakdownKind, key: string): string;
  current: UsageFilter | undefined;
  onFilter(filter: UsageFilter): void;
}) {
  return (
    <section aria-labelledby="usage-where">
      <SectionHeading id="usage-where" title="Where it went" />
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {breakdownKinds.map((kind) => (
          <BreakdownList
            key={kind}
            kind={kind}
            lines={props.lists[kind]}
            metric={props.metric}
            money={props.money}
            name={(key) => props.name(kind, key)}
            current={props.current}
            onFilter={props.onFilter}
          />
        ))}
      </div>
      {props.lists.skill && props.lists.skill.length > 0 && (
        <p className="mt-3 text-xs text-subtle-foreground">
          A turn that used several skills counts in full under each one, so skills overlap.
        </p>
      )}
    </section>
  );
}

function BreakdownList(props: {
  kind: BreakdownKind;
  lines: readonly BreakdownLine[] | undefined;
  metric: "cost" | "tokens";
  money(value: number): string;
  name(key: string): string;
  current: UsageFilter | undefined;
  onFilter(filter: UsageFilter): void;
}) {
  const [all, setAll] = useState(false);
  const { kind, lines } = props;
  const title = breakdownTitles[kind];
  const value = (line: BreakdownLine) => (props.metric === "cost" ? line.usd : line.tokens);
  const top = Math.max(1e-9, ...(lines ?? []).map(value));
  const shown = all ? (lines ?? []) : (lines ?? []).slice(0, breakdownTop);
  return (
    <div aria-label={title} role="group" data-kind={kind}>
      <h3 className="mb-1 text-xs font-semibold text-subtle-foreground">{title}</h3>
      {lines === undefined ? (
        <p className="py-1.5 text-xs text-subtle-foreground">Not recorded on this machine</p>
      ) : lines.length === 0 ? (
        <p className="py-1.5 text-xs text-subtle-foreground">None in this period</p>
      ) : (
        <ul>
          {shown.map((line) => {
            const pressed = props.current?.kind === kind && props.current.key === line.key;
            const label = props.name(line.key);
            return (
              <li key={line.key}>
                <BreakdownRow
                  label={label}
                  pressed={pressed}
                  value={
                    props.metric === "tokens"
                      ? formatTokens(line.tokens)
                      : unpricedLine(line)
                        ? "Unpriced"
                        : props.money(line.usd)
                  }
                  width={(value(line) / top) * 100}
                  onClick={() =>
                    props.onFilter({
                      kind,
                      key: line.key,
                      label: props.name(line.key),
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {lines && lines.length > breakdownTop && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
          className="mt-0.5 rounded-xs py-1 text-xs text-subtle-foreground hover:text-foreground focus-ring"
        >
          {all ? "Show fewer" : `Show all ${lines.length}`}
        </button>
      )}
    </div>
  );
}

function BreakdownRow(props: {
  label: string;
  value: string;
  width: number;
  pressed: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 rounded-sm px-1 py-1.5 text-left text-ui focus-ring hover:bg-hover",
        props.pressed && "bg-active",
      )}
    >
      <span className="truncate">{props.label}</span>
      <span className="text-right tabular-nums">{props.value}</span>
      <span aria-hidden className="col-span-2 h-0.5 rounded-full bg-faint-foreground/40">
        <span
          style={{ width: `${Math.max(1, props.width)}%` }}
          className="block h-full rounded-full bg-subtle-foreground"
        />
      </span>
    </button>
  );
}
