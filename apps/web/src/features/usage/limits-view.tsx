import {
  formatAgo,
  headroomTone,
  joinNames,
  resetCountdown,
  staleReadingMs,
  type AccountLimits,
  type AccountWindow,
  type HeadroomTone,
  type ProviderLimits,
  type UsageLimits,
} from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";
import { cn } from "@/lib/cn.ts";
import { formatResets } from "@/features/accounts/index.ts";

/**
 * Limits, account first: each provider's accounts listed once, each with its windows beneath it.
 * Every figure says what is left; resets, banked resets and pace are plain words. Providers that
 * report nothing, and accounts ace can't tell apart, close the section as one quiet footnote.
 */
export function LimitsView(props: {
  limits: UsageLimits;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { providers, quiet, unsure } = props.limits;
  const footnote = [quiet.length ? `No limits reported for ${joinNames(quiet)}.` : "", ...unsure]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-6">
      {providers.map((group) => (
        <ProviderSection key={group.key} group={group} now={props.now} redeem={props.redeem} />
      ))}
      {footnote && (
        <p data-testid="limits-footnote" className="text-xs text-subtle-foreground">
          {footnote}
        </p>
      )}
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ProviderSection(props: {
  group: ProviderLimits;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { group } = props;
  return (
    <section aria-labelledby={`limits-${group.key}`}>
      <div className="flex items-center gap-2 pb-1">
        <h3 id={`limits-${group.key}`} className="flex items-center gap-2 text-md font-semibold">
          <ProviderIcon
            provider={group.provider}
            acpAgentId={group.acpAgentId}
            size={16}
            decorative
          />
          {group.providerLabel}
        </h3>
        <span className="ml-auto text-ui text-subtle-foreground tabular-nums">
          {plural(group.accounts.length, "account")}
        </span>
      </div>
      {group.accounts.map((entry) => (
        <Account
          key={entry.key}
          entry={entry}
          provider={group.providerLabel}
          now={props.now}
          redeem={props.redeem}
        />
      ))}
    </section>
  );
}

/** The provider's plan name as it reads beside the environment: "plus" → "Plus". */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function Account(props: {
  entry: AccountLimits;
  provider: string;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { entry } = props;
  const banked = entry.bankedResets;
  const canUse = props.redeem !== undefined || entry.account.provider === "claude";
  return (
    <article
      aria-label={`${props.provider} · ${entry.account.label} · ${entry.environment}`}
      className="grid gap-x-6 gap-y-2 border-t border-border py-3 first-of-type:border-t-0 sm:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <div className="min-w-0 text-ui leading-5">
        <h4 className="truncate font-semibold">{entry.account.label}</h4>
        <p className="truncate text-subtle-foreground">
          {entry.plan ? `${planLabel(entry.plan)} · ${entry.environment}` : entry.environment}
        </p>
        {entry.account.isDefault && (
          <p className="text-xs leading-5 font-medium text-status-done">Used for new threads</p>
        )}
        {banked !== undefined && banked > 0 && (
          <div className="flex items-baseline gap-1 text-xs leading-5 whitespace-nowrap text-muted-foreground">
            <Tip
              label={`${plural(banked, "banked reset")}: each one resets this account's limits once, when you redeem it.${
                entry.bankedExpiresAt !== null
                  ? ` The next expires ${expiry.format(entry.bankedExpiresAt)}.`
                  : ""
              }`}
            >
              <span
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
                tabIndex={0}
                className="rounded-xs tabular-nums focus-ring"
              >
                {plural(banked, "banked reset")}
              </span>
            </Tip>
            {canUse && (
              <>
                <span aria-hidden>·</span>
                <BankedResetAction entry={entry} redeem={props.redeem} />
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <ul aria-label={`${entry.account.label} limits`} className="flex flex-col">
          {entry.windows.map((window) => (
            <WindowLine key={window.id} window={window} now={props.now} />
          ))}
        </ul>
        {entry.signIn && <p className="text-ui leading-8 text-muted-foreground">{entry.signIn}</p>}
        {entry.noSessionWindow && (
          <p className="text-xs leading-8 text-subtle-foreground">
            No session (5h) limit reported for this account
          </p>
        )}
      </div>
    </article>
  );
}

/** A reading older than this says how old it is, and no longer counts as a limit. */
const freshMs = staleReadingMs;

/**
 * Every window row is one 40px line: label (with "Ahead of pace" under it when it is), a bar of
 * at most 220px with the even-pace tick, the share left, and when it resets. The label column
 * keeps at least 7rem so "Session (5h)" and "Weekly" never truncate; the bar shrinks first.
 */
const rowGrid =
  "grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(7rem,11rem)_minmax(0,220px)_5.5rem_minmax(0,1fr)]";

const barTone: Record<HeadroomTone, string> = {
  ok: "bg-foreground",
  low: "bg-status-needs-you",
  out: "bg-status-failed",
};

function WindowName(props: { window: AccountWindow; ahead: boolean }) {
  const { window } = props;
  return (
    <div className="min-w-0 leading-4">
      <Tip label={window.label}>
        <span className="block truncate text-ui text-muted-foreground">{window.label}</span>
      </Tip>
      {props.ahead && (
        <Tip label="Ahead of pace: at this rate the window runs out before it resets.">
          <span className="block w-fit max-w-full truncate whitespace-nowrap text-2xs text-status-needs-you">
            Ahead of pace
          </span>
        </Tip>
      )}
    </div>
  );
}

function WindowLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  if (window.stale) return <StaleLine window={window} now={now} />;
  const countdown = resetCountdown(window.resetsAt, now);
  const tone = headroomTone(window.leftPercent);
  const out = tone === "out";
  // Nothing used yet: the window is fresh, whenever it would reset.
  const fresh = window.leftPercent === 100;
  const old = now - window.observedAt > freshMs;
  return (
    <li className={rowGrid}>
      <WindowName window={window} ahead={window.pace === "ahead"} />
      <div
        role="meter"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.leftPercent}
        aria-valuetext={`${window.leftPercent}% left${countdown ? `, resets in ${countdown}` : ""}${old ? `, as of ${formatAgo(window.observedAt, now)}` : ""}`}
        className="relative hidden h-1 rounded-full bg-faint-foreground/45 sm:block"
      >
        <span
          aria-hidden
          style={{ width: `${window.leftPercent}%` }}
          className={cn("absolute inset-y-0 left-0 rounded-full", barTone[tone])}
        />
        {window.evenLeftPercent !== undefined && (
          <span
            aria-hidden
            data-slot="even-pace"
            style={{ left: `${window.evenLeftPercent}%` }}
            className="absolute top-1/2 h-2.5 w-[1.5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground"
          />
        )}
      </div>
      <p className="text-right whitespace-nowrap tabular-nums">
        <span className={cn("text-md font-semibold", out && "text-status-failed")}>
          {window.leftPercent}%
        </span>
        <span className="text-xs text-subtle-foreground"> left</span>
      </p>
      <div className="hidden min-w-0 text-right sm:block">
        <p
          className={cn(
            "truncate text-ui tabular-nums",
            out
              ? "text-status-failed"
              : tone === "low"
                ? "text-status-needs-you"
                : "text-subtle-foreground",
          )}
        >
          {fresh ? (
            "Fresh"
          ) : countdown === null || window.resetsAt === null ? (
            "Reset not reported"
          ) : (
            <Tip label={formatResets(window.resetsAt, now)}>
              {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
              <span tabIndex={0} className="rounded-xs focus-ring">
                {out ? "back in" : "Resets in"} {countdown}
              </span>
            </Tip>
          )}
        </p>
        {old && (
          <p className="truncate text-2xs leading-3 text-faint-foreground">
            As of {formatAgo(window.observedAt, now)}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * A window whose reset passed after its last reading: nothing has been used since, as far as
 * ace knows, so it says so in words, with no bar and no figure, and when it reset.
 */
function StaleLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  const words = window.label.startsWith("Session") ? "No session yet" : "Not used since its reset";
  return (
    <li className={rowGrid}>
      <WindowName window={window} ahead={false} />
      <p className="text-ui text-subtle-foreground sm:col-span-2">{words}</p>
      <p className="hidden truncate text-right text-ui text-subtle-foreground tabular-nums sm:block">
        {window.resetsAt !== null && `Reset ${formatAgo(window.resetsAt, now)}`}
        <span className="block text-2xs leading-3 text-faint-foreground">
          Read {formatAgo(window.observedAt, now)}
        </span>
      </p>
    </li>
  );
}
