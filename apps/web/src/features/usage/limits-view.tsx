import {
  formatAgo,
  joinNames,
  limitTime,
  roundEstimate,
  type AccountLimits,
  type AccountWindow,
  type UsageLimits,
} from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";

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

/** The provider's plan name as it reads beside the environment: "plus" → "Plus". */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function AccountBlock(props: {
  entry: AccountLimits;
  provider: string;
  machine: boolean;
  now: number;
  first: boolean;
  onShow?: (() => void) | undefined;
  redeem?: RedeemReset | undefined;
}) {
  const { entry } = props;
  const banked = entry.bankedResets;
  const canUse = props.redeem !== undefined || entry.account.provider === "claude";
  const name = `${props.provider} · ${entry.account.label}`;
  const meta = [entry.plan && planLabel(entry.plan), props.machine ? entry.environment : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      aria-label={`${name} · ${entry.environment}`}
      className={cn("py-4", !props.first && "border-t border-border")}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
        {meta && <span className="text-xs text-subtle-foreground">{meta}</span>}
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
          <ul aria-label={`${entry.account.label} limits`} className="mt-2.5 flex flex-col gap-3">
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
  const resetNote =
    runsOut && !out && window.resetsAt !== null ? `Resets ${time(window.resetsAt)}` : undefined;
  return (
    <li className={rowGrid}>
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
        <Bar window={window} runsOut={runsOut} />
      </div>
      <Tip label={resetNote ?? `Read ${formatAgo(window.observedAt, now)}`}>
        <span
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
          tabIndex={0}
          className={cn(
            "col-span-2 w-fit truncate rounded-xs text-xs tabular-nums focus-ring @min-[40rem]/limits:order-4 @min-[40rem]/limits:col-span-1 @min-[40rem]/limits:justify-self-end",
            runsOut ? "text-status-failed" : "text-subtle-foreground",
          )}
        >
          {when}
        </span>
      </Tip>
    </li>
  );
}

/**
 * What is left as a fat bar. Lasting: ink up to where the pace leaves it at the reset (the
 * marker), amber for what that pace still uses. Running out: all of it red.
 */
function Bar(props: { window: AccountWindow; runsOut: boolean }) {
  const { window } = props;
  const left = window.stale ? 0 : window.leftPercent;
  const marker = props.runsOut || window.stale ? null : window.leftAtReset;
  const valuetext = window.stale ? "Not used since its reset" : `${window.leftPercent}% left`;
  return (
    <div
      role="meter"
      aria-label={window.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={window.leftPercent}
      aria-valuetext={valuetext}
      className={cn(
        "relative h-2.5 overflow-hidden rounded-full",
        window.leftPercent <= 0 && !window.stale ? "bg-status-failed/20" : "bg-faint-foreground/30",
      )}
    >
      <span className="absolute inset-0">
        {props.runsOut ? (
          <span
            data-runs-out=""
            style={{ width: `${left}%` }}
            className="absolute inset-y-0 left-0 rounded-r-full bg-status-failed"
          />
        ) : (
          <>
            <span
              style={{ width: `${marker ?? left}%` }}
              className={cn(
                "absolute inset-y-0 left-0 bg-muted-foreground",
                // The fill's end is round; where the pace part follows, the notch parts them.
                !(marker !== null && marker < left) && "rounded-r-full",
              )}
            />
            {marker !== null && marker < left && (
              <span
                data-pace=""
                style={{ left: `${marker}%`, width: `${left - marker}%` }}
                className="usage-pace absolute inset-y-0 rounded-r-full"
              />
            )}
          </>
        )}
      </span>
      {/* Where the pace leaves it at the reset: a notch in the bar's own height. */}
      {marker !== null && marker < left && (
        <span
          aria-hidden
          style={{ left: `${marker}%` }}
          className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-background"
        />
      )}
    </div>
  );
}
