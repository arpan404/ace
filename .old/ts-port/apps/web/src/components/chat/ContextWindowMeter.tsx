import { GLASS_PANEL_CLASS_NAME } from "~/components/ui/glass";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value > 0 && value < 0.1) {
    return "<0.1%";
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function formatDuration(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(/\.0$/, "")} s`;
}

function formatTokenDetail(label: string, value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return `${formatContextWindowTokens(value)} ${label}`;
}

function formatToolUses(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const count = Math.round(value);
  return `${count} tool${count === 1 ? "" : "s"}`;
}

export function ContextWindowMeter(props: { usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const latestTurnDetails = [
    formatTokenDetail("in", usage.lastInputTokens),
    formatTokenDetail("cached", usage.lastCachedInputTokens),
    formatTokenDetail("out", usage.lastOutputTokens),
    formatTokenDetail("reasoning", usage.lastReasoningOutputTokens),
  ].filter((detail): detail is string => detail !== null);
  const latestMetaDetails = [
    formatToolUses(usage.toolUses),
    formatDuration(usage.durationMs),
  ].filter((detail): detail is string => detail !== null);

  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        closeDelay={80}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-all duration-200 hover:opacity-85 hover:scale-105"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context usage ${formatContextWindowTokens(usage.usedTokens)} tokens`
            }
          >
            <span className="relative flex size-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 50%, transparent)"
                  strokeWidth="2.5"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
                  style={{ opacity: 0.7 }}
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-3.75 w-3.75 items-center justify-center rounded-full bg-background text-[8px] font-semibold tabular-nums",
                  "text-muted-foreground/80",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <TooltipPopup
        side="top"
        align="end"
        sideOffset={8}
        className={cn(
          GLASS_PANEL_CLASS_NAME,
          "w-max max-w-72 rounded-[var(--panel-radius)] px-3 py-2.5 text-xs [&_[data-slot=tooltip-viewport]]:px-0 [&_[data-slot=tooltip-viewport]]:py-0",
        )}
      >
        <div className="space-y-1.5 leading-tight">
          <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            Context window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap font-medium text-foreground">
              <span className="text-primary">{usedPercentage}</span>
              <span className="mx-1.5 text-muted-foreground/35">·</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span className="text-muted-foreground/45">/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="text-foreground">
              Latest observed usage: {formatContextWindowTokens(usage.usedTokens)} tokens
            </div>
          )}
          {latestTurnDetails.length > 0 ? (
            <div className="text-[11px] text-muted-foreground/75">
              Latest turn: {latestTurnDetails.join(" · ")}
            </div>
          ) : null}
          {latestMetaDetails.length > 0 ? (
            <div className="text-[11px] text-muted-foreground/75">
              {latestMetaDetails.join(" · ")}
            </div>
          ) : null}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-[11px] text-muted-foreground/75">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-[11px] text-muted-foreground/75">
              Automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
