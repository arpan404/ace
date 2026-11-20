import { Link } from "@tanstack/react-router";
import {
  formatAgo,
  limitCardLine,
  type AccountLimits,
  type AccountWindow,
  type RailUsage,
} from "@ace/ui-core";
import { useRef, useState } from "react";
import { railPlaceClass } from "@/components/rail-place.ts";
import { UsageBars } from "@/components/usage-bars.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useMachines } from "@/lib/machines.ts";
import { cn } from "@/lib/cn.ts";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";
import { LimitBar } from "./limit-bar.tsx";
import { useUsageHeadroom } from "./use-usage-headroom.ts";

/**
 * Usage in the rail's foot, above Settings: the bars, a card on hover or focus with each
 * provider's current account and its limits, and the Usage page on click.
 */
export function UsagePlace(props: { current: boolean }) {
  const usage = useUsageHeadroom();
  const redeem = useRedeemReset(usage.refresh);
  const [open, setOpen] = useState(false);
  // A banked reset's confirmation sits over the card; the card stays until it closes.
  const confirming = useRef(false);
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (next || !confirming.current) setOpen(next);
      }}
    >
      <HoverCardTrigger
        delay={300}
        closeDelay={120}
        render={
          <Link
            to="/usage"
            aria-label={usage.rail.label}
            aria-current={props.current ? "page" : undefined}
            data-state={props.current ? "active" : undefined}
            data-part="rail-item"
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
          className="w-[24rem] max-w-[calc(100vw-24px)] px-3.5 py-2.5"
        >
          <UsageCard
            rail={usage.rail}
            now={usage.now}
            observedAt={usage.observedAt}
            redeem={redeem}
            onDialogChange={(next) => {
              confirming.current = next;
              if (!next) setOpen(false);
            }}
            close={() => setOpen(false)}
          />
        </HoverCardContent>
      )}
    </HoverCard>
  );
}

/** Spends one of an account's banked resets on this computer's daemon, then reads usage again. */
export function useRedeemReset(refresh: () => Promise<unknown>): RedeemReset {
  const machines = useMachines();
  return async (entry, idempotencyKey) => {
    const client = machines.find((machine) => machine.primary)?.client;
    if (!client) throw new Error("Machine is offline");
    const reply = await client.request({
      type: "accounts.consumeReset",
      instanceId: entry.account.id,
      idempotencyKey,
    });
    await refresh();
    return reply.outcome;
  };
}

/** One grid for every row of the card: label, bar, share left, when. */
const cardGrid = "grid grid-cols-[3.75rem_minmax(0,1fr)_2.25rem_7.25rem] items-center gap-x-2.5";

const plural = (count: number) => `${count} banked reset${count === 1 ? "" : "s"}`;

/**
 * The card: each provider's current account (the one new threads use) with every window it
 * reports, drawn as the Usage page draws them, its banked resets on its name's line, and the way
 * to the page.
 */
function UsageCard(props: {
  rail: RailUsage;
  now: number;
  observedAt: number | undefined;
  redeem: RedeemReset;
  onDialogChange(open: boolean): void;
  close(): void;
}) {
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
      <UsageAccounts
        rail={props.rail}
        now={props.now}
        redeem={props.redeem}
        onDialogChange={props.onDialogChange}
      />
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

/**
 * Each provider's current account and every window it reports, its banked resets on its name's
 * line: the card's body, and the menu-bar popover's Usage.
 */
export function UsageAccounts(props: {
  rail: RailUsage;
  now: number;
  redeem: RedeemReset;
  onDialogChange(open: boolean): void;
}) {
  const shown = props.rail.accounts.filter((entry) => entry.windows.length > 0);
  if (shown.length === 0)
    return <p className="mt-1 text-xs text-subtle-foreground">No limits read yet.</p>;
  return (
    <>
      {shown.map((entry) => (
        <section
          key={entry.key}
          aria-label={`${entry.account.providerLabel} · ${entry.account.label}`}
          className="mt-3 first:mt-0 text-ui tabular-nums"
        >
          <div className="mb-1 flex items-center gap-1.5">
            <ProviderIcon
              provider={entry.account.provider}
              acpAgentId={entry.account.acpAgentId}
              size={14}
              decorative
            />
            <span className="min-w-0 truncate font-medium">
              {entry.account.providerLabel}
              <span className="font-normal text-muted-foreground"> · {entry.account.label}</span>
            </span>
            <Banked entry={entry} redeem={props.redeem} onDialogChange={props.onDialogChange} />
          </div>
          {entry.windows.map((window) => (
            <CardWindow key={window.id} window={window} now={props.now} />
          ))}
        </section>
      ))}
    </>
  );
}

/** An account's banked resets at the right of its name, with the way to spend one. */
function Banked(props: {
  entry: AccountLimits;
  redeem: RedeemReset;
  onDialogChange(open: boolean): void;
}) {
  const banked = props.entry.bankedResets;
  if (banked === undefined || banked <= 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-baseline gap-2 text-xs text-subtle-foreground">
      {plural(banked)}
      <BankedResetAction
        entry={props.entry}
        redeem={props.redeem}
        onDialogChange={props.onDialogChange}
      />
    </span>
  );
}

/** A window's short name in the card: "Session", "Weekly", and a model's own week by its model: "Fable". */
const shortLabel = (label: string) =>
  label === "Session (5h)" ? "Session" : label.startsWith("Weekly · ") ? label.slice(9) : label;

function CardWindow(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  const when = limitCardLine(window, now);
  return (
    <div
      role="group"
      className={cn(cardGrid, "min-h-6 text-xs")}
      aria-label={`${window.label}: ${when.spoken}`}
    >
      <span title={window.label} className="truncate text-muted-foreground">
        {shortLabel(window.label)}
      </span>
      <LimitBar window={window} size="sm" />
      <span
        className={cn(
          "text-right font-medium text-foreground",
          window.stale && "font-normal text-subtle-foreground",
        )}
      >
        {window.stale ? "–" : `${window.leftPercent}%`}
      </span>
      <span
        className={cn(
          "truncate text-right",
          when.strong ? "font-medium text-foreground" : "text-subtle-foreground",
        )}
      >
        {when.lead}
      </span>
      {when.rest && (
        <span className="col-span-4 -mt-0.5 pb-0.5 text-right text-subtle-foreground">
          {when.rest}
        </span>
      )}
    </div>
  );
}
