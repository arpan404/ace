import {
  formatAgo,
  resetCountdown,
  type AccountLimits,
  type AccountWindow,
  type LimitPace,
  type ProviderLimits,
  type UsageLimits,
} from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { formatResets } from "@/features/accounts/index.ts";

/**
 * Limits, account first: each provider's accounts listed once, each with its windows beneath it.
 * Every figure says what is left; resets, banked resets and pace are plain words.
 */
export function LimitsView(props: { limits: UsageLimits; now: number }) {
  const { providers, quiet } = props.limits;
  return (
    <div className="flex flex-col gap-10">
      {providers.map((group) => (
        <ProviderSection key={group.key} group={group} now={props.now} />
      ))}
      {quiet.length > 0 && (
        <p className="text-xs text-subtle-foreground">No limits reported · {quiet.join(", ")}</p>
      )}
    </div>
  );
}

function ProviderSection(props: { group: ProviderLimits; now: number }) {
  const { group } = props;
  return (
    <section aria-labelledby={`limits-${group.key}`}>
      <h2
        id={`limits-${group.key}`}
        className="flex items-center gap-2 border-b border-border pb-3.5 font-prose text-base font-semibold"
      >
        <ProviderIcon
          provider={group.provider}
          acpAgentId={group.acpAgentId}
          size={14}
          decorative
        />
        {group.providerLabel}
      </h2>
      {group.accounts.map((entry) => (
        <Account key={entry.key} entry={entry} provider={group.providerLabel} now={props.now} />
      ))}
    </section>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function Account(props: { entry: AccountLimits; provider: string; now: number }) {
  const { entry } = props;
  const banked = entry.bankedResets;
  return (
    <article
      aria-label={`${props.provider} · ${entry.account.label} · ${entry.environment}`}
      className="grid gap-x-8 gap-y-3 border-b border-border-soft py-4 last:border-b-0 sm:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold break-words">{entry.account.label}</h3>
        <p className="text-ui text-subtle-foreground">{entry.environment}</p>
        {banked !== undefined && banked > 0 && (
          <Tip
            label={`${plural(banked, "banked reset")}: each one resets this account's limits once, when you redeem it in ${props.provider}.${
              entry.bankedExpiresAt !== null
                ? ` The next expires ${expiry.format(entry.bankedExpiresAt)}.`
                : ""
            }`}
          >
            <span
              tabIndex={0}
              className="mt-2.5 inline-block rounded-xs text-xs text-muted-foreground underline decoration-faint-foreground decoration-dotted underline-offset-3 focus-ring"
            >
              {plural(banked, "banked reset")}
            </span>
          </Tip>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ul aria-label={`${entry.account.label} limits`} className="flex flex-col gap-3">
          {entry.windows.map((window) => (
            <WindowLine key={window.id} window={window} now={props.now} />
          ))}
        </ul>
        {entry.noSessionWindow && (
          <p className="text-xs text-subtle-foreground">
            No 5-hour limit reported for this account
          </p>
        )}
      </div>
    </article>
  );
}

const paceText: Record<Exclude<LimitPace, "on_pace">, { label: string; tip: string }> = {
  ahead: {
    label: "Ahead of pace",
    tip: "Ahead of pace: at this rate the window runs out before it resets.",
  },
  behind: {
    label: "Under pace",
    tip: "Under pace: this window will last until it resets with room to spare.",
  },
};

function Pace(props: { pace: LimitPace | undefined }) {
  if (!props.pace || props.pace === "on_pace") return null;
  const text = paceText[props.pace];
  return (
    <Tip label={text.tip}>
      <span
        tabIndex={0}
        className={cn(
          "block w-fit rounded-xs text-2xs underline decoration-dotted underline-offset-3 focus-ring",
          props.pace === "ahead" ? "text-status-needs-you" : "text-subtle-foreground",
        )}
      >
        {text.label}
      </span>
    </Tip>
  );
}

/** A reading older than this says how old it is. */
const freshMs = 30 * 60_000;

function WindowLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  if (window.stale) return <StaleLine window={window} now={now} />;
  const countdown = resetCountdown(window.resetsAt, now);
  const out = window.leftPercent === 0;
  const old = now - window.observedAt > freshMs;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13.75rem_5.25rem_minmax(0,1fr)_7.5rem]">
      <div className="min-w-0">
        <span className="block text-ui break-words text-muted-foreground">{window.label}</span>
        <Pace pace={window.pace} />
      </div>
      <p className="text-right whitespace-nowrap">
        <span
          className={cn(
            "font-prose text-lg leading-none font-semibold tabular-nums",
            out && "text-status-failed",
          )}
        >
          {window.leftPercent}%
        </span>{" "}
        <span className="text-xs text-subtle-foreground">left</span>
      </p>
      <div
        role="meter"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.leftPercent}
        aria-valuetext={`${window.leftPercent}% left${countdown ? `, resets in ${countdown}` : ""}${old ? `, as of ${formatAgo(window.observedAt, now)}` : ""}`}
        className={cn(
          "relative col-span-2 h-0.5 sm:col-span-1",
          out ? "bg-status-failed/50" : "bg-border",
        )}
      >
        <span
          aria-hidden
          style={{ width: `${window.leftPercent}%` }}
          className="absolute inset-y-0 left-0 bg-foreground"
        />
      </div>
      <div className="col-span-2 sm:col-span-1 sm:text-right">
        <p
          className={cn(
            "text-xs whitespace-nowrap sm:text-ui",
            out ? "text-status-failed" : "text-subtle-foreground",
          )}
        >
          {countdown === null || window.resetsAt === null ? (
            "Reset not reported"
          ) : (
            <Tip label={formatResets(window.resetsAt, now)}>
              <span tabIndex={0} className="rounded-xs tabular-nums focus-ring">
                {out ? "Back in" : "Resets in"} {countdown}
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

/**
 * A window whose reset passed after its last reading: what is left now is unknown until the
 * provider reports again, so it shows no figure, only how old the reading is.
 */
function StaleLine(props: { window: AccountWindow; now: number }) {
  const { window, now } = props;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13.75rem_5.25rem_minmax(0,1fr)_7.5rem]">
      <span className="text-ui break-words text-muted-foreground">{window.label}</span>
      <p className="text-right font-prose text-lg leading-none text-faint-foreground">—</p>
      <div
        aria-hidden
        className="col-span-2 h-0.5 border-t border-dashed border-border sm:col-span-1"
      />
      <p className="col-span-2 text-xs text-subtle-foreground sm:col-span-1 sm:text-right">
        {window.resetsAt !== null && `Reset ${formatAgo(window.resetsAt, now)}`}
        <span className="block text-2xs text-faint-foreground">
          Read {formatAgo(window.observedAt, now)}
        </span>
      </p>
    </li>
  );
}
