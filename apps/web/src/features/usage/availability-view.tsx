import {
  accountAvailability,
  availabilityAxis,
  availabilitySentence,
  axisPercent,
  joinNames,
  windowNoun,
  type AccountAvailability,
  type AccountLimits,
  type AvailabilityAxis,
  type UsageLimits,
} from "@ace/ui-core";
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
  const machine =
    new Set(providers.flatMap((group) => group.accounts.map((each) => each.environment))).size > 1;
  const rows = providers.flatMap((group) => group.accounts.map((entry) => ({ group, entry })));
  return (
    <div className="@container/limits">
      <div className="grid grid-cols-1 @min-[40rem]/limits:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] @min-[40rem]/limits:gap-x-5">
        {rows.map(({ group, entry }, index) => (
          <AccountRow
            key={entry.key}
            first={index === 0}
            entry={entry}
            provider={group.providerLabel}
            axis={axis}
            machine={machine}
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

/** The provider's plan name as it reads beside the environment: "plus" → "Plus". */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const expiry = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** What the row leaves out, in words: plan, machine, each window's share left. */
function details(entry: AccountLimits, machine: boolean): string {
  const where = [entry.plan && planLabel(entry.plan), machine ? entry.environment : undefined];
  const windows = entry.windows.map((window) =>
    window.stale
      ? `${window.label}: not used since its reset`
      : `${window.label}: ${window.leftPercent}% left`,
  );
  return [
    where.filter(Boolean).join(" · "),
    ...windows,
    entry.noSessionWindow ? "No session (5h) limit reported for this account" : "",
    entry.account.isDefault ? "Used for new threads" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One account: its name, its band, and one line under the band. The plan, machine, each window's
 * share left and whether new threads use it are in the name's tooltip and its spoken text.
 */
function AccountRow(props: {
  entry: AccountLimits;
  provider: string;
  axis: AvailabilityAxis;
  first: boolean;
  /** Name the machine: accounts come from more than one. */
  machine: boolean;
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
      <div className={cn("min-w-0 pt-3.5 pb-2 @min-[40rem]/limits:pb-3.5", edge)}>
        <h4 className="flex min-w-0 text-md font-medium">
          <Tip label={<span className="whitespace-pre-line">{details(entry, props.machine)}</span>}>
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
            <span tabIndex={0} className="flex min-w-0 items-center gap-2 rounded-xs focus-ring">
              <ProviderIcon
                provider={entry.account.provider}
                acpAgentId={entry.account.acpAgentId}
                size={16}
                decorative
              />
              <span className="truncate">
                {props.provider} · {entry.account.label}
              </span>
            </span>
          </Tip>
        </h4>
        {(props.machine || (banked !== undefined && banked > 0)) && (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 pl-6 text-xs text-subtle-foreground">
            {props.machine && <span className="truncate">{entry.environment}</span>}
            {banked !== undefined && banked > 0 && (
              <span className="flex items-baseline gap-x-1">
                <Tip
                  label={`Each banked reset resets this account's limits once, when you redeem it.${
                    entry.bankedExpiresAt !== null
                      ? ` The next expires ${expiry.format(entry.bankedExpiresAt)}.`
                      : ""
                  }`}
                >
                  {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
                  <span tabIndex={0} className="rounded-xs focus-ring">
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
        )}
        <Figures entry={entry} />
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
          props.onShow ? (
            <button
              type="button"
              onClick={props.onShow}
              aria-label={`${sentence.text}. Show this account's spend`}
              className="block w-full rounded-sm py-1.5 hover:opacity-80 focus-ring"
            >
              <Band availability={availability} axis={axis} />
            </button>
          ) : (
            <Band availability={availability} axis={axis} label={sentence.text} />
          )
        ) : null}
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
          {entry.windows.length > 0 && !entry.signIn && (
            <p
              className={cn(
                sentence.tone === "out" && "text-status-failed",
                sentence.tone === "low" && "text-status-needs-you",
                sentence.tone === "ok" && "text-subtle-foreground",
              )}
            >
              {sentence.text}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/** Each window's share left, for assistive tech; sighted readers have the name's tooltip. */
function Figures(props: { entry: AccountLimits }) {
  const { entry } = props;
  return (
    <div className="sr-only">
      {entry.plan && <p>{`${planLabel(entry.plan)} · ${entry.environment}`}</p>}
      <ul>
        {entry.windows.map((window) => (
          <li
            key={window.id}
            role="meter"
            aria-label={window.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={window.leftPercent}
            aria-valuetext={
              window.stale ? "Not used since its reset" : `${window.leftPercent}% left`
            }
          >
            {window.stale
              ? "Not used since its reset"
              : `${window.leftPercent}% ${windowNoun(window)}`}
          </li>
        ))}
      </ul>
      {entry.noSessionWindow && <p>No session (5h) limit reported for this account</p>}
      {entry.account.isDefault && <p>Used for new threads</p>}
    </div>
  );
}

function Band(props: {
  availability: AccountAvailability;
  axis: AvailabilityAxis;
  /** Its spoken name, when the band isn't inside a control that already has one. */
  label?: string | undefined;
}) {
  const { axis } = props;
  // A thin line from now to a week out; only the stretches it is out take colour.
  return (
    <div
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      className="relative h-1 rounded-full bg-faint-foreground/45"
    >
      {props.availability.stretches
        .filter((stretch) => stretch.out)
        .map((stretch) => {
          const left = axisPercent(axis, stretch.from);
          const width = axisPercent(axis, stretch.to) - left;
          return (
            <span
              key={stretch.from}
              data-out=""
              style={{ left: `${left}%`, width: `max(4px, ${width}%)` }}
              className={cn(
                "absolute inset-y-0 rounded-full",
                stretch.from === axis.from ? "bg-status-failed" : "bg-status-needs-you",
              )}
            />
          );
        })}
    </div>
  );
}
