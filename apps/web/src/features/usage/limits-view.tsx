import { PushPinIcon } from "@phosphor-icons/react";
import {
  limitDetails,
  railBars,
  joinNames,
  limitTime,
  roundEstimate,
  type AccountLimits,
  type AccountWindow,
  type UsageLimits,
} from "@ace/ui-core";
import { Fragment } from "react";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import type { Machine } from "@/lib/machines.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";
import { LimitBar } from "./limit-bar.tsx";

/**
 * Limits, one account at a time with each of its windows (a session, a week, a model's own week,
 * whatever its provider reports) as a bar of what is left. A marker shows where the bar will be
 * when it resets if use carries on at this pace; the part between is what that pace will still
 * use (amber). A window that pace runs out before its reset is red, with when it runs out.
 * Providers that report nothing, and accounts ace can't tell apart, close it as one footnote.
 */
export function LimitsView(props: {
  limits: UsageLimits;
  now: number;
  /** The machine an account was read on, for its mark beside its name. */
  machineOf?(entry: AccountLimits): Machine | undefined;
  /** Pinning to this device's rail: the pinned account ids, and pin or unpin one. */
  pins?: RailPinning | undefined;
  /** Show the account's spend: its name is a button for it. */
  onAccount?(entry: AccountLimits): void;
  redeem?: RedeemReset | undefined;
}) {
  const { providers, quiet, unsure } = props.limits;
  const footnote = [quiet.length ? `No limits reported for ${joinNames(quiet)}.` : "", ...unsure]
    .filter(Boolean)
    .join(" ");
  const machine =
    new Set(providers.flatMap((group) => group.accounts.map((each) => each.environment))).size > 1;
  const rows = providers.flatMap((group) => group.accounts.map((entry) => ({ group, entry })));
  return (
    <div className="@container/limits">
      {rows.map(({ group, entry }, index) => (
        <AccountBlock
          key={entry.key}
          first={index === 0}
          entry={entry}
          provider={group.providerLabel}
          machine={machine}
          machineOf={props.machineOf}
          pins={props.pins}
          now={props.now}
          onShow={props.onAccount && (() => props.onAccount?.(entry))}
          redeem={props.redeem}
        />
      ))}
      {footnote && (
        <p data-testid="limits-footnote" className="mt-3 text-xs text-subtle-foreground">
          {footnote}
        </p>
      )}
    </div>
  );
}

function EntryMachineMark(props: { machine: Machine | undefined }) {
  if (!props.machine) return null;
  return (
    <MachineMark icon={props.machine.icon} primary={props.machine.primary} size={12} decorative />
  );
}

/** The accounts pinned to this device's rail, and the way to change them. */
export interface RailPinning {
  ids: readonly string[];
  toggle(id: string): void;
}

/**
 * Pin an account to the rail, so its bar and card show it instead of the accounts used most. A
 * pinned account keeps its pin in view; others show theirs under the pointer or focus. Four at
 * most, as the rail draws four.
 */
function PinButton(props: { id: string; name: string; pins: RailPinning }) {
  const pinned = props.pins.ids.includes(props.id);
  const full = !pinned && props.pins.ids.length >= railBars;
  const label = pinned
    ? `Unpin ${props.name} from the rail`
    : full
      ? `The rail shows ${railBars} accounts; unpin one to pin ${props.name}`
      : `Pin ${props.name} to the rail`;
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pinned}
        aria-disabled={full || undefined}
        onClick={() => {
          if (!full) props.pins.toggle(props.id);
        }}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground hover:bg-hover hover:text-foreground focus-ring",
          !pinned && "opacity-0 group-hover/account:opacity-100 focus-visible:opacity-100",
          full && "cursor-not-allowed hover:text-subtle-foreground",
        )}
      >
        <PushPinIcon size={14} weight={pinned ? "fill" : "regular"} aria-hidden />
      </button>
    </Tip>
  );
}

/** The provider's plan name as it reads beside the environment: "plus" → "Plus". */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function AccountBlock(props: {
  entry: AccountLimits;
  provider: string;
  machine: boolean;
  machineOf?: ((entry: AccountLimits) => Machine | undefined) | undefined;
  pins?: RailPinning | undefined;
  now: number;
  first: boolean;
  onShow?: (() => void) | undefined;
  redeem?: RedeemReset | undefined;
}) {
  const { entry } = props;
  const banked = entry.bankedResets;
  const canUse = props.redeem !== undefined || entry.account.provider === "claude";
  const name = `${props.provider} · ${entry.account.label}`;
  const plan = entry.plan && planLabel(entry.plan);
  return (
    <article
      aria-label={`${name} · ${entry.environment}`}
      className={cn("py-4", !props.first && "border-t border-border")}
    >
      <div className="group/account flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h4 className="flex min-w-0 items-center gap-2 text-md font-medium">
          <ProviderIcon
            provider={entry.account.provider}
            acpAgentId={entry.account.acpAgentId}
            size={16}
            decorative
          />
          {props.onShow ? (
            <button
              type="button"
              onClick={props.onShow}
              aria-label={`${name}: show its spend`}
              className="truncate rounded-xs hover:underline focus-ring"
            >
              {name}
            </button>
          ) : (
            <span className="truncate">{name}</span>
          )}
        </h4>
        {(plan || props.machine) && (
          <span className="flex min-w-0 items-center gap-x-1.5 text-xs text-subtle-foreground">
            {plan}
            {plan && props.machine && <span aria-hidden>·</span>}
            {props.machine && (
              <span className="flex min-w-0 items-center gap-1">
                <EntryMachineMark machine={props.machineOf?.(entry)} />
                <span className="truncate">{entry.environment}</span>
              </span>
            )}
          </span>
        )}
        {/* The rail reads this machine's accounts, so only they pin to it. Last in the line, so a
            hidden pin leaves no gap. */}
        {props.pins && props.machineOf?.(entry)?.primary && (
          <PinButton id={entry.account.id} name={name} pins={props.pins} />
        )}
        {entry.account.isDefault && <span className="sr-only">Used for new threads</span>}
        {banked !== undefined && banked > 0 && (
          <span className="ml-auto flex items-baseline gap-x-1 text-xs text-subtle-foreground">
            <Tip
              label={`Each banked reset resets this account's limits once, when you redeem it.${
                entry.bankedExpiresAt !== null
                  ? ` The next expires ${expiry.format(entry.bankedExpiresAt)}.`
                  : ""
              }`}
            >
              {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
              <span tabIndex={0} className="rounded-xs tabular-nums focus-ring">
                {plural(banked, "banked reset")}
              </span>
            </Tip>
            {canUse && (
              <>
                <span aria-hidden>·</span>
                <BankedResetAction entry={entry} redeem={props.redeem} />
              </>
            )}
          </span>
        )}
      </div>
      {entry.signIn ? (
        <p className="mt-2 text-ui text-muted-foreground">{entry.signIn}</p>
      ) : (
        entry.windows.length > 0 && (
          <ul aria-label={`${entry.account.label} limits`} className="mt-1.5 flex flex-col gap-0.5">
            {entry.windows.map((window) => (
              <WindowRow key={window.id} window={window} now={props.now} />
            ))}
          </ul>
        )
      )}
      {entry.noSessionWindow && (
        <p className="mt-2 text-xs text-subtle-foreground">
          No session (5h) limit reported for this account
        </p>
      )}
    </article>
  );
}

/**
 * Label · bar · share left · when. Wide, one line; narrow, the label and share left share the
 * first line and the bar and when sit under them.
 */
const rowGrid = cn(
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5",
  "@min-[40rem]/limits:grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_4rem_minmax(7rem,9.5rem)]",
);

function WindowRow(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  const time = (at: number) => limitTime(at, now);
  const out = window.leftPercent <= 0;
  const runsOut = !window.stale && (out || window.runsOutAt !== null);
  const fresh = !window.stale && window.leftPercent >= 100;
  const when = window.stale
    ? "Not used since its reset"
    : out
      ? window.resetsAt === null
        ? "Out, reset not reported"
        : `Out until ${time(window.resetsAt)}`
      : window.runsOutAt !== null
        ? `Runs out around ${time(roundEstimate(window.runsOutAt, now))}`
        : fresh
          ? "Fresh"
          : window.resetsAt === null
            ? "Reset not reported"
            : `Resets ${time(window.resetsAt)}`;
  const cells = (
    <>
      <span title={window.label} className="truncate text-ui text-muted-foreground">
        {window.label}
      </span>
      <span
        className={cn(
          "text-right text-md font-semibold tabular-nums @min-[40rem]/limits:order-3",
          runsOut && "text-status-failed",
          window.stale && "font-normal text-subtle-foreground",
        )}
      >
        {window.stale ? "–" : `${window.leftPercent}%`}
        {!window.stale && <span className="text-xs font-normal text-subtle-foreground"> left</span>}
      </span>
      <div className="col-span-2 @min-[40rem]/limits:order-2 @min-[40rem]/limits:col-span-1">
        <LimitBar window={window} runsOut={runsOut} />
      </div>
      <span
        className={cn(
          "col-span-2 truncate text-xs tabular-nums @min-[40rem]/limits:order-4 @min-[40rem]/limits:col-span-1 @min-[40rem]/limits:text-right",
          runsOut ? "text-status-failed" : "text-subtle-foreground",
        )}
      >
        {when}
      </span>
    </>
  );
  return (
    <li>
      <HoverCard>
        <HoverCardTrigger
          // Opens once the pointer settles; leaving the row closes it at once.
          delay={300}
          closeDelay={0}
          // A focusable group, so the keyboard opens its card too; its meter stays inside it.
          render={<div role="group" />}
          tabIndex={0}
          aria-label={`${window.label}: ${window.stale ? "not used since its reset" : `${window.leftPercent}% left`}, ${when}`}
          className={cn(
            rowGrid,
            "-mx-2 rounded-md px-2 py-1.5 transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
          )}
        >
          {cells}
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="center"
          sideOffset={6}
          aria-label={`${window.label} details`}
          className="w-72 px-3 py-2.5"
        >
          <p className="mb-1.5 text-ui font-medium text-foreground">{window.label}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs tabular-nums">
            {limitDetails(window, now).map((line) => (
              <Fragment key={line.label}>
                <dt className="text-subtle-foreground">{line.label}</dt>
                <dd
                  className={cn(
                    "text-right",
                    line.tone === "out" ? "text-status-failed" : "text-foreground",
                  )}
                >
                  {line.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        </HoverCardContent>
      </HoverCard>
    </li>
  );
}
