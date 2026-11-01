import {
  formatAgo,
  headroomTone,
  type HeadroomTone,
  resetCountdown,
  staleReadingMs,
  type AccountLimits,
  type AccountWindow,
  type LimitPace,
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
 * Every figure says what is left; resets, banked resets and pace are plain words.
 */
export function LimitsView(props: {
  limits: UsageLimits;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { providers, quiet, unsure } = props.limits;
  return (
    <div className="flex flex-col gap-2">
      {providers.map((group) => (
        <ProviderSection key={group.key} group={group} now={props.now} redeem={props.redeem} />
      ))}
      {quiet.length > 0 && (
        <p className="text-xs text-subtle-foreground">No limits reported · {quiet.join(", ")}</p>
      )}
      {unsure.map((line) => (
        <p key={line} className="text-xs text-subtle-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function ProviderSection(props: {
  group: ProviderLimits;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { group } = props;
  return (
    <section aria-labelledby={`limits-${group.key}`}>
      <h2
        id={`limits-${group.key}`}
        className="flex items-center gap-2 pt-4 pb-1.5 text-md font-semibold"
      >
        <ProviderIcon
          provider={group.provider}
          acpAgentId={group.acpAgentId}
          size={14}
          decorative
        />
        {group.providerLabel}
        <span className="ml-auto text-ui font-medium text-muted-foreground">
          {plural(group.accounts.length, "account")}
        </span>
      </h2>
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
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function Account(props: {
  entry: AccountLimits;
  provider: string;
  now: number;
  redeem?: RedeemReset | undefined;
}) {
  const { entry } = props;
  const banked = entry.bankedResets;
  return (
    <article
      aria-label={`${props.provider} · ${entry.account.label} · ${entry.environment}`}
      className="grid gap-x-6 gap-y-3 border-t border-border py-3 first-of-type:border-t-0 sm:grid-cols-[12.5rem_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold break-words">{entry.account.label}</h3>
        <p className="text-ui text-subtle-foreground">
          {entry.plan ? `${planLabel(entry.plan)} · ${entry.environment}` : entry.environment}
        </p>
        {entry.account.isDefault && (
          <p className="mt-1.5 text-xs font-medium text-status-done">Used for new threads</p>
        )}
        {banked !== undefined && banked > 0 && (
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground">
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
                className="rounded-xs focus-ring"
              >
                {plural(banked, "banked reset")}
              </span>
            </Tip>
            {props.redeem !== undefined || entry.account.provider === "claude" ? (
              <>
                <span aria-hidden>·</span>
                <BankedResetAction entry={entry} redeem={props.redeem} />
              </>
            ) : null}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ul aria-label={`${entry.account.label} limits`} className="flex flex-col gap-1.5">
          {entry.windows.map((window) => (
            <WindowLine key={window.id} window={window} now={props.now} />
          ))}
        </ul>
        {entry.signIn && <p className="text-ui text-muted-foreground">{entry.signIn}</p>}
        {entry.noSessionWindow && (
          <p className="text-xs text-subtle-foreground">
            No session (5h) limit reported for this account
          </p>
        )}
      </div>
    </article>
  );
}

const paceText: Record<"ahead", { label: string; tip: string }> = {
  ahead: {
    label: "Ahead of pace",
    tip: "Ahead of pace: at this rate the window runs out before it resets.",
  },
};

function Pace(props: { pace: LimitPace | undefined }) {
  if (!props.pace) return null;
  if (props.pace !== "ahead")
    return <span className="block text-2xs text-subtle-foreground">On pace</span>;
  const text = paceText[props.pace];
  return (
    <Tip label={text.tip}>
      <span
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
        tabIndex={0}
        className={cn(
          "block w-fit rounded-xs text-2xs underline decoration-dotted underline-offset-3 focus-ring",
          "text-status-needs-you",
        )}
      >
        {text.label}
      </span>
    </Tip>
  );
}

/** A reading older than this says how old it is, and no longer counts as a limit. */
const freshMs = staleReadingMs;

const rowGrid =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-0.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_3.5rem_8.5rem]";

function WindowLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  if (window.stale) return <StaleLine window={window} now={now} />;
  const countdown = resetCountdown(window.resetsAt, now);
  const tone = headroomTone(window.leftPercent);
  const out = tone === "out";
  const fresh =
    window.leftPercent === 100 && (window.pace === undefined || window.pace === "behind");
  const old = now - window.observedAt > freshMs;
  return (
    <li className={rowGrid}>
      <div className="min-w-0">
        <span className="block text-ui break-words text-muted-foreground">{window.label}</span>
        <Pace pace={window.pace} />
      </div>
      <p className="text-right whitespace-nowrap sm:order-3">
        <span
          className={cn(
            "text-md leading-none font-semibold tabular-nums",
            out && "text-status-failed",
          )}
        >
          {window.leftPercent}%
        </span>
        <span className="sr-only"> left</span>
      </p>
      <div
        role="meter"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.leftPercent}
        aria-valuetext={`${window.leftPercent}% left${countdown ? `, resets in ${countdown}` : ""}${old ? `, as of ${formatAgo(window.observedAt, now)}` : ""}`}
        className="relative col-span-2 h-1.5 rounded-full bg-faint-foreground/50 sm:order-2 sm:col-span-1"
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
            title="Even pace"
            style={{ left: `${window.evenLeftPercent}%` }}
            className="absolute -inset-y-[3px] w-[1.5px] -translate-x-1/2 bg-subtle-foreground"
          />
        )}
      </div>
      <div className="col-span-2 sm:order-4 sm:col-span-1 sm:text-right">
        <p
          className={cn(
            "text-xs whitespace-nowrap sm:text-ui",
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
              <span tabIndex={0} className="rounded-xs tabular-nums focus-ring">
                {out ? "back in" : "Resets in"} {countdown}
              </span>
            </Tip>
          )}
        </p>
        {old && (
          <p className="text-2xs text-faint-foreground">
            As of {formatAgo(window.observedAt, now)}
          </p>
        )}
      </div>
    </li>
  );
}

const barTone: Record<HeadroomTone, string> = {
  ok: "bg-foreground",
  low: "bg-status-needs-you",
  out: "bg-status-failed",
};

/**
 * A window whose reset passed after its last reading: what is left now is unknown until the
 * provider reports again, so it shows no figure, only how old the reading is.
 */
function StaleLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  return (
    <li className={rowGrid}>
      <span className="text-ui break-words text-muted-foreground">{window.label}</span>
      <p className="text-right text-md leading-none text-faint-foreground sm:order-3">—</p>
      <div
        aria-hidden
        className="col-span-2 h-0.5 border-t border-dashed border-border sm:order-2 sm:col-span-1"
      />
      <p className="col-span-2 text-xs text-subtle-foreground sm:order-4 sm:col-span-1 sm:text-right">
        {window.resetsAt !== null && `Reset ${formatAgo(window.resetsAt, now)}`}
        <span className="block text-2xs text-faint-foreground">
          Read {formatAgo(window.observedAt, now)}
        </span>
      </p>
    </li>
  );
}
