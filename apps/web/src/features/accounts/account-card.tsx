import { ArrowRightIcon, PlayIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { blockingReset } from "@ace/ui-core";
import { useMoveThreads } from "./account-threads-source.ts";
import type { Account, QuotaWindow } from "./accounts-source.ts";
import { formatClock, formatResets } from "./format.ts";

const radius = 18;
const circumference = 2 * Math.PI * radius;

/** One quota window as a ring: ink normally, amber from 85%, red when exhausted. */
export function UsageRing(props: { window: QuotaWindow; now: number }) {
  const used = Math.min(100, Math.max(0, props.window.usedPercent));
  const tone =
    used >= 100
      ? "stroke-status-failed"
      : used >= 85
        ? "stroke-status-needs-you"
        : "stroke-foreground";
  const resets =
    props.window.resetsAt === null
      ? "Reset time not reported"
      : formatResets(props.window.resetsAt, props.now);
  return (
    <div className="flex items-center gap-2.5">
      <span
        role="meter"
        aria-label={`${props.window.label} window`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${used}% used, ${resets.toLowerCase()}`}
        className="relative grid size-11 place-items-center"
      >
        <svg viewBox="0 0 44 44" className="size-11 -rotate-90" aria-hidden>
          <circle
            cx="22"
            cy="22"
            r={radius}
            fill="none"
            strokeWidth={4.5}
            className="stroke-secondary"
          />
          <circle
            cx="22"
            cy="22"
            r={radius}
            fill="none"
            strokeWidth={4.5}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - used / 100)}
            className={cn(tone, "transition-[stroke-dashoffset] duration-[600ms] ease-smooth")}
          />
        </svg>
        {/* Three digits and a % crowd the ring: a full window reads "100", the % is in the value text. */}
        <span aria-hidden className="absolute text-[11px] font-medium tabular-nums">
          {used >= 100 ? "100" : `${used}%`}
        </span>
      </span>
      <span className="text-sm font-medium">
        {props.window.label}
        <small className="mt-px block text-xs font-normal text-subtle-foreground">{resets}</small>
      </span>
    </div>
  );
}

const threads = (n: number) => `${n} running ${n === 1 ? "thread" : "threads"}`;

/**
 * An account: its quota rings, running threads, and for one with threads stopped at its limit,
 * the way out. `accounts` are its siblings, to pick where the threads go.
 */
export function AccountCard(props: { account: Account; accounts: readonly Account[] }) {
  const { account } = props;
  const now = useNow();
  const move = useMoveThreads();
  const toast = useToast();
  const exhausted = account.availability === "exhausted";
  const resetsAt = blockingReset(account);
  const limited = account.threads?.limitedIds ?? [];
  const waiting = limited.length;
  return (
    <article
      aria-label={`${account.providerLabel} ${account.label}`}
      className={cn(
        "rounded-lg px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)]",
        exhausted &&
          "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--status-failed)_35%,transparent)]",
      )}
    >
      <div className="flex items-center gap-2 text-base font-medium">
        {account.label}
        {!account.signedIn && (
          <span className="text-sm font-normal text-subtle-foreground">Signed out</span>
        )}
        {exhausted && (
          <span className="ml-auto rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-status-failed">
            Limit reached
          </span>
        )}
      </div>
      {account.windows.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-x-[26px] gap-y-3">
          {account.windows.map((window) => (
            <UsageRing key={window.id} window={window} now={now} />
          ))}
        </div>
      ) : (
        account.signedIn && (
          <p className="mt-2 text-sm text-subtle-foreground">
            {account.providerLabel} doesn't report usage
          </p>
        )
      )}
      {waiting > 0 ? (
        <div className="mt-3.5 flex items-center gap-2.5 rounded-card bg-status-failed/9 px-3 py-2.5 text-sm leading-[1.45] text-muted-foreground">
          <span className="min-w-0 flex-1">
            {waiting} {waiting === 1 ? "thread is" : "threads are"} paused until the window resets
            {resetsAt === undefined ? "" : ` at ${formatClock(resetsAt)}`}.
          </span>
          <Button
            size="sm"
            disabled={move.isPending}
            onClick={() =>
              move.mutate(
                { accounts: props.accounts, from: account.id, threadIds: limited },
                {
                  onSuccess: (result) =>
                    toast.add({
                      title: `Moved ${result.moved} ${result.moved === 1 ? "thread" : "threads"} to ${result.to.providerLabel} · ${result.to.label}${result.failed ? `; ${result.failed} couldn't move` : ""}`,
                    }),
                  onError: (error) => toast.add({ title: error.message }),
                },
              )
            }
          >
            <Icon icon={ArrowRightIcon} size={14} />
            Move running threads
          </Button>
        </div>
      ) : (
        account.threads !== undefined &&
        account.threads.running > 0 && (
          <div className="mt-3.5 flex items-center gap-2 text-sm text-muted-foreground">
            <Icon icon={PlayIcon} size={14} />
            {threads(account.threads.running)}
          </div>
        )
      )}
    </article>
  );
}
