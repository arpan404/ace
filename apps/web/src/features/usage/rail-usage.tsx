import { Link } from "@tanstack/react-router";
import {
  formatAgo,
  headroomSentence,
  headroomTone,
  resetCountdown,
  type AccountWindow,
  type HeadroomTone,
  type ProviderHeadroom,
} from "@ace/ui-core";
import { useState } from "react";
import { railPlaceClass } from "@/components/rail-place.ts";
import { UsageBars } from "@/components/usage-bars.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { useUsageHeadroom } from "./use-usage-headroom.ts";

/**
 * Usage in the rail's foot, above Settings: the bars, a card on hover or focus that says which
 * provider is tightest and each one's session and week, and the Usage page on click.
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
        <HoverCardContent side="right" align="end" className="w-[340px] px-4 pt-3.5 pb-2.5">
          <UsageCard
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

function UsageCard(props: {
  headroom: readonly ProviderHeadroom[];
  now: number;
  observedAt: number | undefined;
  close(): void;
}) {
  const shown = props.headroom.filter((entry) => entry.session || entry.weekly);
  return (
    <div data-slot="usage-card">
      <p className="text-ui font-semibold">Usage</p>
      <p className="mt-0.5 text-ui text-muted-foreground">
        {headroomSentence(props.headroom, props.now)}
      </p>
      {shown.map((entry) => (
        <section key={entry.key} aria-label={entry.providerLabel} className="mt-3">
          <p className="flex items-center gap-2 text-ui font-semibold">
            <ProviderIcon
              provider={entry.provider}
              acpAgentId={entry.acpAgentId}
              size={14}
              decorative
            />
            {entry.providerLabel}
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {entry.current?.account.label}
              {entry.accounts > 1 && ` · ${entry.accounts} accounts`}
            </span>
          </p>
          {entry.session && <CardWindow label="Session" window={entry.session} now={props.now} />}
          {entry.weekly && <CardWindow label="Weekly" window={entry.weekly} now={props.now} />}
        </section>
      ))}
      <p className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs text-subtle-foreground">
        <span>
          {props.observedAt === undefined
            ? "Not read yet"
            : `Updated ${formatAgo(props.observedAt, props.now)}`}
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

const barTone: Record<HeadroomTone, string> = {
  ok: "bg-foreground",
  low: "bg-status-needs-you",
  out: "bg-status-failed",
};

function CardWindow(props: { label: string; window: AccountWindow; now: number }) {
  const { window, now } = props;
  const left = window.stale ? null : window.leftPercent;
  const tone = left === null ? "ok" : headroomTone(left);
  const countdown = resetCountdown(window.resetsAt, now);
  return (
    <div className="mt-1.5 grid grid-cols-[4.5rem_minmax(0,1fr)_2.75rem_4rem] items-center gap-2 text-xs text-muted-foreground">
      <span>{props.label}</span>
      <span aria-hidden className="h-1 overflow-hidden rounded-full bg-faint-foreground/60">
        <span
          style={{ width: `${left ?? 0}%` }}
          className={cn("block h-full rounded-full", barTone[tone])}
        />
      </span>
      <span className="text-right font-semibold text-foreground tabular-nums">
        {left === null ? "—" : `${left}%`}
      </span>
      <span
        className={cn(
          "text-right whitespace-nowrap tabular-nums",
          tone === "out" ? "text-status-failed" : "text-subtle-foreground",
        )}
      >
        {window.stale ? "Reset" : left === 100 && window.resetsAt === null ? "Fresh" : countdown}
      </span>
    </div>
  );
}
