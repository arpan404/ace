import {
  accountAvailability,
  availabilityAxis,
  availabilitySentence,
  axisPercent,
  axisTicks,
  headroomTone,
  joinNames,
  windowNoun,
  type AccountAvailability,
  type AccountLimits,
  type AccountWindow,
  type AvailabilityAxis,
  type UsageLimits,
} from "@ace/ui-core";
import { Fragment } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";

/**
 * Limits as availability: one timeline from now to a week out, the next five hours wide, and a
 * band per account showing when it can work and when it is out (hatched). Under each band, one
 * sentence: when it runs out and is back, or that it lasts and with how much to spare. Providers
 * that report nothing, and accounts ace can't tell apart, close it as one quiet footnote.
 */
export function AvailabilityView(props: {
  limits: UsageLimits;
  now: number;
  /** Show the account's spend: its band is a button for it. */
  onAccount?(entry: AccountLimits): void;
  redeem?: RedeemReset | undefined;
}) {
  const { providers, quiet, unsure } = props.limits;
  const axis = availabilityAxis(props.now);
  const footnote = [quiet.length ? `No limits reported for ${joinNames(quiet)}.` : "", ...unsure]
    .filter(Boolean)
    .join(" ");
  const rows = providers.flatMap((group) => group.accounts.map((entry) => ({ group, entry })));
  return (
    <div className="@container/limits">
      <div className="grid grid-cols-1 @min-[40rem]/limits:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] @min-[40rem]/limits:gap-x-5">
        <Axis axis={axis} />
        {rows.map(({ group, entry }, index) => (
          <AccountRow
            key={entry.key}
            first={index === 0}
            entry={entry}
            provider={group.providerLabel}
            axis={axis}
            onShow={props.onAccount && (() => props.onAccount?.(entry))}
            redeem={props.redeem}
          />
        ))}
      </div>
      {footnote && (
        <p data-testid="limits-footnote" className="mt-3 text-xs text-subtle-foreground">
          {footnote}
        </p>
      )}
    </div>
  );
}

function Axis(props: { axis: AvailabilityAxis }) {
  const ticks = axisTicks(props.axis);
  return (
    <div
      aria-hidden
      className="relative h-5 text-xs text-subtle-foreground tabular-nums @min-[40rem]/limits:col-start-2"
    >
      {ticks.map((tick) => (
        <span
          key={tick.at}
          style={{ left: `${axisPercent(props.axis, tick.at)}%` }}
          className={cn(
            "absolute top-0 whitespace-nowrap",
            tick.kind === "now" && "font-medium text-foreground",
            // Too narrow for the hours beside "Now": the days alone carry the axis.
            tick.kind === "hour" && "hidden -translate-x-1/2 @min-[36rem]/limits:block",
          )}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

/** The provider's plan name as it reads beside the environment: "plus" → "Plus". */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function AccountRow(props: {
  entry: AccountLimits;
  provider: string;
  axis: AvailabilityAxis;
  first: boolean;
  onShow?: (() => void) | undefined;
  redeem?: RedeemReset | undefined;
}) {
  const { entry, axis } = props;
  const availability = accountAvailability(entry, axis);
  const sentence = availabilitySentence(availability, axis.from);
  const banked = entry.bankedResets;
  const canUse = props.redeem !== undefined || entry.account.provider === "claude";
  const edge = props.first ? "" : "border-t border-border";
  return (
    <article
      aria-label={`${props.provider} · ${entry.account.label} · ${entry.environment}`}
      className="contents"
    >
      <div className={cn("min-w-0 py-3.5 text-xs leading-[18px] text-subtle-foreground", edge)}>
        <h4 className="mb-0.5 flex items-center gap-2 text-md font-semibold text-foreground">
          <ProviderIcon
            provider={entry.account.provider}
            acpAgentId={entry.account.acpAgentId}
            size={16}
            decorative
          />
          <span className="truncate">
            {props.provider} · {entry.account.label}
          </span>
        </h4>
        <p className="truncate">
          {entry.plan ? `${planLabel(entry.plan)} · ${entry.environment}` : entry.environment}
          {entry.account.isDefault && (
            <span className="font-medium text-status-done"> · Used for new threads</span>
          )}
        </p>
        {entry.windows.length > 0 && <WindowFigures windows={entry.windows} />}
        {banked !== undefined && banked > 0 && (
          <p className="flex flex-wrap items-baseline gap-x-1 text-muted-foreground">
            <Tip
              label={`${plural(banked, "banked reset")}: each one resets this account's limits once, when you redeem it.${
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
          </p>
        )}
      </div>
      <div
        className={cn(
          "min-w-0 pb-3.5 @min-[40rem]/limits:pt-3.5",
          // Stacked, the band sits under its account with no rule between them.
          props.first ? "" : "@min-[40rem]/limits:border-t @min-[40rem]/limits:border-border",
        )}
      >
        {entry.signIn ? (
          <p className="text-ui leading-[22px] text-muted-foreground">{entry.signIn}</p>
        ) : entry.windows.length > 0 ? (
          <>
            {props.onShow ? (
              <button
                type="button"
                onClick={props.onShow}
                aria-label={`${sentence.text}. Show this account's spend`}
                className="block w-full rounded-sm hover:opacity-80 focus-ring"
              >
                <Band availability={availability} axis={axis} />
              </button>
            ) : (
              <Band availability={availability} axis={axis} label={sentence.text} />
            )}
            <p
              className={cn(
                "mt-2 text-xs tabular-nums",
                sentence.tone === "out" && "text-status-failed",
                sentence.tone === "low" && "text-status-needs-you",
                sentence.tone === "ok" && "text-muted-foreground",
              )}
            >
              {sentence.text}
            </p>
          </>
        ) : null}
        {entry.noSessionWindow && (
          <p className="mt-1 text-xs text-subtle-foreground">
            No session (5h) limit reported for this account
          </p>
        )}
      </div>
    </article>
  );
}

/** "18% session · 41% week": what each window has left, coloured only when it runs short. */
function WindowFigures(props: { windows: readonly AccountWindow[] }) {
  return (
    <p className="tabular-nums">
      {props.windows.map((window, index) => {
        const tone = headroomTone(window.leftPercent);
        const short = tone !== "ok" || window.runsOutAt !== null;
        return (
          <Fragment key={window.id}>
            {index > 0 && <span aria-hidden> · </span>}
            {/* One figure stays together; one longer than the column wraps inside itself. */}
            <span
              role="meter"
              className="inline-block max-w-full"
              aria-label={window.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={window.leftPercent}
              aria-valuetext={
                window.stale ? "Not used since its reset" : `${window.leftPercent}% left`
              }
            >
              <span
                className={cn(
                  "font-semibold text-foreground",
                  short && "text-status-needs-you",
                  tone === "out" && "text-status-failed",
                  window.stale && "font-normal text-subtle-foreground",
                )}
              >
                {window.stale ? "–" : `${window.leftPercent}%`}
              </span>{" "}
              {windowNoun(window)}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

function Band(props: {
  availability: AccountAvailability;
  axis: AvailabilityAxis;
  /** Its spoken name, when the band isn't inside a control that already has one. */
  label?: string | undefined;
}) {
  const { axis } = props;
  const detail = axis.detailShare * 100;
  return (
    <div
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      className="relative h-[22px]"
    >
      {props.availability.stretches.map((stretch) => {
        const left = axisPercent(axis, stretch.from);
        const width = axisPercent(axis, stretch.to) - left;
        return (
          <span
            key={stretch.from}
            data-out={stretch.out ? "" : undefined}
            data-now={stretch.out && stretch.from === axis.from ? "" : undefined}
            style={{ left: `calc(${left}% + 1px)`, width: `max(2px, calc(${width}% - 2px))` }}
            className={cn(
              "absolute inset-y-0 rounded-sm",
              stretch.out ? "usage-out" : "usage-usable",
            )}
          />
        );
      })}
      <span
        aria-hidden
        style={{ left: `${detail}%` }}
        className="absolute -inset-y-1.5 border-l border-dashed border-border"
      />
    </div>
  );
}
