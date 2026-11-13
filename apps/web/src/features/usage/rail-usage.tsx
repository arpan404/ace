import { Link } from "@tanstack/react-router";
import {
  formatAgo,
  headroomAlert,
  limitTime,
  resetCountdown,
  roundEstimate,
  type AccountWindow,
  type PooledHeadroom,
  type RailUsage,
} from "@ace/ui-core";
import { useState } from "react";
import { railPlaceClass } from "@/components/rail-place.ts";
import { UsageBars } from "@/components/usage-bars.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { LimitBar } from "./limit-bar.tsx";
import { useUsageHeadroom } from "./use-usage-headroom.ts";

/**
 * Usage in the rail's foot, above Settings: the bars, a card on hover or focus with each
 * provider's current account and its limits, and the Usage page on click.
 */
export function UsagePlace(props: { current: boolean }) {
  const usage = useUsageHeadroom();
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={300}
        closeDelay={120}
        render={
          <Link
            to="/usage"
            aria-label={usage.rail.label}
            aria-current={props.current ? "page" : undefined}
            className={railPlaceClass}
            data-slot="rail-usage"
          />
        }
      >
        <UsageBars bars={usage.rail.bars} />
      </HoverCardTrigger>
      {open && (
        <HoverCardContent
          side="right"
          sideOffset={8}
          align="end"
          aria-label="Usage"
          className="w-[26rem] max-w-[calc(100vw-24px)] px-3.5 py-2.5"
        >
          <UsageCard
            rail={usage.rail}
            headroom={usage.headroom}
            now={usage.now}
            observedAt={usage.observedAt}
            close={() => setOpen(false)}
          />
        </HoverCardContent>
      )}
    </HoverCard>
  );
}

/** One grid for every row of the card: label, bar, share left, when. */
const cardGrid = "grid grid-cols-[6.5rem_minmax(0,1fr)_2.25rem_6.25rem] items-center gap-x-2.5";

/**
 * The card: a provider whose every account is out, when one is, then each
 * provider's current account (the one new threads use) with every window it reports, drawn as the
 * Usage page draws them, and the way to the page.
 */
function UsageCard(props: {
  rail: RailUsage;
  headroom: readonly PooledHeadroom[];
  now: number;
  observedAt: number | undefined;
  close(): void;
}) {
  const shown = props.rail.accounts.filter((entry) => entry.windows.length > 0);
  const alert = headroomAlert(props.headroom, props.now);
  return (
    <div data-slot="usage-card" className="text-ui tabular-nums">
      <p className="flex h-6 items-center justify-between">
        <span className="font-medium text-foreground">Usage</span>
        <span className="text-xs text-subtle-foreground">
          {props.observedAt === undefined
            ? "Not read yet"
            : `Read ${formatAgo(props.observedAt, props.now)}`}
        </span>
      </p>
      {alert && <p className="mt-0.5 text-xs leading-4 text-status-failed">{alert.text}</p>}
      {shown.length === 0 && (
        <p className="mt-1 text-xs text-subtle-foreground">No limits read yet.</p>
      )}
      {shown.map((entry) => (
        <section
          key={entry.key}
          aria-label={`${entry.account.providerLabel} · ${entry.account.label}`}
          className="mt-3"
        >
          <p className="mb-1 flex items-center gap-1.5">
            <ProviderIcon
              provider={entry.account.provider}
              acpAgentId={entry.account.acpAgentId}
              size={14}
              decorative
            />
            <span className="truncate font-medium">
              {entry.account.providerLabel}
              <span className="font-normal text-muted-foreground"> · {entry.account.label}</span>
            </span>
          </p>
          {entry.windows.map((window) => (
            <CardWindow key={window.id} window={window} now={props.now} />
          ))}
        </section>
      ))}
      <p className="mt-3 flex h-8 items-center justify-between border-t border-border text-xs">
        <span className="text-subtle-foreground">
          {props.rail.pinned ? "Pinned" : "Used most this week"}
        </span>
        <Link
          to="/usage"
          onClick={props.close}
          className="rounded-xs font-medium text-foreground focus-ring hover:underline"
        >
          Open Usage ›
        </Link>
      </p>
    </div>
  );
}

/** A window's short name in the card: "Session", "Weekly", "Weekly · Fable". */
const shortLabel = (label: string) => (label === "Session (5h)" ? "Session" : label);

function CardWindow(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  const out = !window.stale && window.leftPercent <= 0;
  const runsOut = !window.stale && (out || window.runsOutAt !== null);
  const when = window.stale
    ? "Reset"
    : out
      ? window.resetsAt === null
        ? "Out"
        : `Back ${limitTime(window.resetsAt, now)}`
      : window.runsOutAt !== null
        ? `Out ~${limitTime(roundEstimate(window.runsOutAt, now), now)}`
        : (resetCountdown(window.resetsAt, now) ?? "");
  return (
    <div className={cn(cardGrid, "h-6 text-xs")}>
      <span title={window.label} className="truncate text-muted-foreground">
        {shortLabel(window.label)}
      </span>
      <LimitBar window={window} runsOut={runsOut} size="sm" />
      <span
        className={cn(
          "text-right font-medium",
          runsOut ? "text-status-failed" : "text-foreground",
          window.stale && "font-normal text-subtle-foreground",
        )}
      >
        {window.stale ? "–" : `${window.leftPercent}%`}
      </span>
      <span
        className={cn(
          "truncate text-right",
          runsOut ? "text-status-failed" : "text-subtle-foreground",
        )}
      >
        {when}
      </span>
    </div>
  );
}
