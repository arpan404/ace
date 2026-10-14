import { ProviderKind } from "@ace/protocol";
import { formatShare, formatTokens, formatUsd, type UsageReport } from "@ace/ui-core";
import { useState } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";

type Metric = "tokens" | "cost";
type Group = "model" | "day";

interface Line {
  key: string;
  name: string;
  provider?: string | undefined;
  tokens: number;
  usd: number | null;
}

const groups = [
  { value: "model", label: "Model" },
  { value: "day", label: "Day" },
] as const satisfies readonly { value: Group; label: string }[];
const dayName = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Usage per model or per day, largest first, with each line's share as a provider-coloured
 * underline. In money, models ace has no price for fold into one quiet line at the end.
 */
export function Breakdown(props: {
  report: UsageReport;
  metric: Metric;
  modelName(provider: string, model: string): string;
}) {
  const [group, setGroup] = useState<Group>("model");
  const [showUnpriced, setShowUnpriced] = useState(false);
  const { report, metric } = props;
  const lines: Line[] =
    group === "model"
      ? report.models.map((model) => ({
          key: model.key,
          name: props.modelName(model.provider, model.model),
          provider: model.provider,
          tokens: model.tokens,
          usd: model.usd,
        }))
      : report.days
          .filter((day) => day.tokens > 0)
          .map((day) => ({
            key: day.day,
            name: dayName.format(Date.parse(`${day.day}T00:00:00Z`)),
            tokens: day.tokens,
            usd: day.usd,
          }));
  const value = (line: Line) => (metric === "cost" ? (line.usd ?? 0) : line.tokens);
  const whole = metric === "cost" ? report.usd : report.tokens;
  const sorted =
    group === "day"
      ? lines.toReversed()
      : lines.toSorted((a, b) => value(b) - value(a) || b.tokens - a.tokens);
  const priced = metric === "cost" ? sorted.filter((line) => line.usd !== null) : sorted;
  const unpriced = metric === "cost" ? sorted.filter((line) => line.usd === null) : [];
  const shown = showUnpriced ? [...priced, ...unpriced] : priced;
  const top = Math.max(1, ...priced.map(value));
  return (
    <section aria-labelledby="usage-breakdown" className="mt-10">
      <div className="mb-2 flex items-center gap-3">
        <h2
          id="usage-breakdown"
          className="min-w-0 flex-1 text-xs font-medium text-muted-foreground"
        >
          Breakdown
        </h2>
        <SegmentedControl
          label="Break down by"
          size="sm"
          value={group}
          options={groups}
          onValueChange={(next) => setGroup(next)}
        />
      </div>
      <table className="w-full text-ui">
        <caption className="sr-only">
          {metric === "cost" ? "Cost" : "Tokens"} by {group}
        </caption>
        <thead>
          <tr className="text-left text-xs text-subtle-foreground">
            <th scope="col" className="w-8 py-1.5 font-normal">
              #
            </th>
            <th scope="col" className="py-1.5 font-normal">
              {group === "model" ? "Model" : "Day"}
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Cost
            </th>
            <th scope="col" className="w-20 py-1.5 text-right font-normal">
              Share
            </th>
            <th scope="col" className="w-20 py-1.5 text-right font-normal">
              Tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((line, index) => (
            <BreakdownLine
              key={line.key}
              line={line}
              rank={index + 1}
              share={formatShare(value(line), whole)}
              width={line.usd === null && metric === "cost" ? 0 : (value(line) / top) * 100}
            />
          ))}
          {!shown.length && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-subtle-foreground">
                No usage in this range
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {unpriced.length > 0 && (
        <button
          type="button"
          aria-expanded={showUnpriced}
          onClick={() => setShowUnpriced((open) => !open)}
          className="mt-1 rounded-xs py-1.5 text-xs text-subtle-foreground hover:text-foreground focus-ring"
        >
          {showUnpriced ? "Hide" : "Show"} {unpriced.length} unpriced{" "}
          {unpriced.length === 1 ? "model" : "models"} ·{" "}
          {formatTokens(unpriced.reduce((sum, line) => sum + line.tokens, 0))} tokens
        </button>
      )}
    </section>
  );
}

function BreakdownLine(props: { line: Line; rank: number; share: string; width: number }) {
  const { line } = props;
  const provider = ProviderKind.safeParse(line.provider);
  return (
    <tr className="border-t border-border-soft">
      <td className="py-2 align-top text-xs text-subtle-foreground tabular-nums">{props.rank}</td>
      <td className="py-2 pr-3">
        <div data-provider={line.provider} className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            {provider.success && <ProviderIcon provider={provider.data} size={14} />}
            <span className="truncate">{line.name}</span>
          </span>
          <span aria-hidden className="block w-60 max-w-full">
            <span
              style={{ width: `${Math.max(props.width, 1)}%` }}
              className={cn(
                "block h-0.5 rounded-full",
                line.provider ? "bg-(--provider)" : "bg-foreground",
              )}
            />
          </span>
        </div>
      </td>
      <td
        className={cn(
          "py-2 text-right align-top tabular-nums",
          line.usd === null && "text-subtle-foreground",
        )}
      >
        {line.usd === null ? "Unpriced" : formatUsd(line.usd)}
      </td>
      <td className="py-2 text-right align-top text-muted-foreground tabular-nums">
        {props.share}
      </td>
      <td className="py-2 text-right align-top tabular-nums">{formatTokens(line.tokens)}</td>
    </tr>
  );
}
