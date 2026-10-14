import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  StackSimpleIcon,
  TrendDownIcon,
  TrendUpIcon,
} from "@phosphor-icons/react";
import {
  resetCountdown,
  type LimitPace,
  type LimitRow,
  type LimitSegment,
  type ProviderLimitGroup,
  type UsageLimits,
} from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { formatResets } from "@/features/accounts/index.ts";

/** Each provider's windows, one row per window, every figure what is LEFT. */
export function LimitsView(props: { limits: UsageLimits; now: number }) {
  const { providers, quiet } = props.limits;
  return (
    <div className="flex flex-col gap-8">
      {providers.map((group) => (
        <ProviderLimits key={group.key} group={group} now={props.now} />
      ))}
      {quiet.length > 0 && (
        <p className="text-ui text-subtle-foreground">No limits reported · {quiet.join(", ")}</p>
      )}
    </div>
  );
}

function ProviderLimits(props: { group: ProviderLimitGroup; now: number }) {
  const { group } = props;
  return (
    <section aria-labelledby={`limits-${group.key}`} data-provider={group.provider}>
      <h2
        id={`limits-${group.key}`}
        className="mb-2 flex items-center gap-2 text-ui font-medium text-foreground"
      >
        <ProviderIcon
          provider={group.provider}
          acpAgentId={group.acpAgentId}
          size={14}
          decorative
        />
        {group.providerLabel}
      </h2>
      <ul className="flex flex-col gap-2">
        {group.rows.map((row) => (
          <LimitRowView key={row.label} row={row} provider={group.providerLabel} now={props.now} />
        ))}
      </ul>
    </section>
  );
}

const paceText: Record<LimitPace, string> = {
  ahead: "Running out faster than the window resets",
  on_pace: "On pace to last until the window resets",
  behind: "Plenty to last until the window resets",
};

function Pace(props: { pace: LimitPace }) {
  const Icon =
    props.pace === "ahead" ? TrendUpIcon : props.pace === "behind" ? TrendDownIcon : ArrowRightIcon;
  return (
    <Tip label={paceText[props.pace]}>
      <span
        role="img"
        aria-label={paceText[props.pace]}
        tabIndex={0}
        className={cn(
          "inline-flex rounded-xs focus-ring",
          props.pace === "ahead" ? "text-status-needs-you" : "text-subtle-foreground",
        )}
      >
        <Icon size={14} aria-hidden />
      </span>
    </Tip>
  );
}

function LimitRowView(props: { row: LimitRow; provider: string; now: number }) {
  const { row } = props;
  return (
    <li
      aria-label={`${props.provider} ${row.label}`}
      className="grid items-center gap-x-6 gap-y-2 rounded-lg border border-border-soft bg-surface-1 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col">
        <span className="line-clamp-2 text-xs break-words text-muted-foreground">{row.label}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-2xl leading-tight font-medium tabular-nums">
            {row.leftPercent}%{" "}
            <span className="text-ui font-normal text-muted-foreground">left</span>
          </span>
          {row.pace && <Pace pace={row.pace} />}
        </span>
      </div>
      {/* Side by side while each account has room; stacked, one bar per account, when not. */}
      <div className="@container/bar min-w-0">
        <div
          role="group"
          aria-label={`${row.label} by account`}
          className={cn(
            "flex min-w-0 gap-0.5 overflow-hidden rounded-md",
            row.segments.length > 1 && "@max-[38rem]/bar:flex-col",
          )}
        >
          {row.segments.map((segment) => (
            <Segment key={segment.accountId} segment={segment} window={row.label} now={props.now} />
          ))}
        </div>
      </div>
    </li>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Segment(props: { segment: LimitSegment; window: string; now: number }) {
  const { segment, now } = props;
  const countdown = resetCountdown(segment.resetsAt, now);
  const banked = segment.bankedResets;
  return (
    <div
      role="meter"
      aria-label={`${segment.account.providerLabel} · ${segment.label} · ${props.window}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={segment.leftPercent}
      aria-valuetext={`${segment.leftPercent}% left${countdown ? `, resets in ${countdown}` : ""}`}
      className={cn(
        "@container relative h-7 min-w-0 flex-1",
        segment.leftPercent === 0 ? "bg-status-failed/20" : "bg-(--provider)/12",
      )}
    >
      <span
        aria-hidden
        style={{ width: `${segment.leftPercent}%` }}
        className={cn("absolute inset-y-0 left-0", "bg-(--provider)/40")}
      />
      <span className="relative flex h-full items-center gap-1.5 px-2 text-xs text-foreground">
        <span className="min-w-0 truncate @max-[11rem]:hidden">{segment.label}</span>
        <span aria-hidden className="tabular-nums">
          {segment.leftPercent}%
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {countdown && segment.resetsAt !== null && (
            <Chip label={formatResets(segment.resetsAt, now)}>
              <ArrowClockwiseIcon size={11} aria-hidden />
              <span>
                <span className="sr-only">Resets in </span>
                {countdown}
              </span>
            </Chip>
          )}
          {banked !== undefined && banked > 0 && (
            <Chip
              label={`${plural(banked, "banked reset")}: each one resets this account's limits once, when you redeem it in ${segment.account.providerLabel}.${
                segment.bankedExpiresAt !== null
                  ? ` The next expires ${new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                    }).format(segment.bankedExpiresAt)}.`
                  : ""
              }`}
            >
              <StackSimpleIcon size={11} aria-hidden />
              <span>
                {banked}
                <span className="sr-only"> banked {banked === 1 ? "reset" : "resets"}</span>
              </span>
            </Chip>
          )}
        </span>
      </span>
    </div>
  );
}

function Chip(props: { label: string; children: React.ReactNode }) {
  return (
    <Tip label={props.label}>
      <span
        tabIndex={0}
        className="inline-flex h-5 items-center gap-1 rounded-sm bg-background/70 px-1.5 text-2xs text-foreground tabular-nums focus-ring"
      >
        {props.children}
      </span>
    </Tip>
  );
}
