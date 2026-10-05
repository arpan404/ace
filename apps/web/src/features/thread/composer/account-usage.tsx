import type { ThreadStatus } from "@ace/protocol";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import {
  accountLimit,
  accountName,
  atLimitLine,
  formatClock,
  headroom,
  migrationTarget,
  quotaWindowShort,
} from "@ace/ui-core";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { formatResetCountdown, WindowBar } from "@/features/accounts/index.ts";
import { cn } from "@/lib/cn.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { useThreadAccount } from "../lib/thread-account.ts";

/**
 * The account's usage windows beside the context meter: its tightest window as "5h 62%" (amber
 * near the limit, red at it), and every window with its reset on hover or focus. Nothing when the
 * thread has no account yet or its provider reports no windows.
 */
export function AccountMeter(props: { threadId: string }) {
  const { account, accounts } = useThreadAccount(props.threadId);
  const now = useNow();
  if (!account?.windows.length) return null;
  const limit = accountLimit(account);
  const window = limit.window;
  if (!window) return null;
  const name = accountName(account);
  const target = accounts && migrationTarget(accounts, account.id);
  const reached = limit.level === "reached";
  const short = reached
    ? limit.resetsAt === undefined
      ? "Limit"
      : `Limit · ${formatClock(limit.resetsAt)}`
    : `${quotaWindowShort(window)} ${window.usedPercent}%`;
  const resets = formatResetCountdown(limit.resetsAt ?? window.resetsAt, now);
  return (
    // A glass card rather than the inverted tooltip, so the bars keep the meters' tones.
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            tabIndex={0}
            aria-label={`${name} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={window.usedPercent}
            aria-valuetext={`${reached ? "Limit reached" : `${window.usedPercent}% of ${window.label} window used`}, ${resets.toLowerCase()}`}
            className={cn(
              "inline-flex h-(--composer-control) shrink-0 items-center rounded-full px-2 text-xs tabular-nums outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]",
              reached
                ? "text-status-failed"
                : limit.level === "near"
                  ? "text-status-needs-you"
                  : "text-subtle-foreground",
            )}
          >
            {short}
          </span>
        }
      />
      <TooltipContent
        side="top"
        className="glass w-64 flex-col items-stretch gap-3 rounded-lg bg-glass p-3 text-xs font-normal whitespace-normal text-popover-foreground"
      >
        <span className="text-sm font-medium">{name}</span>
        {account.windows.map((entry) => (
          <WindowBar key={entry.id} window={entry} now={now} />
        ))}
        {limit.level !== "ok" && (
          <span className="text-muted-foreground">
            {reached ? "Usage limit reached. " : "Near its usage limit. "}
            {target
              ? `${accountName(target)} has ${headroom(target)}% left.`
              : `No other ${account.providerLabel} account has room.`}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Above the composer when the thread's account is near a limit (and not yet at it, which the
 * queue notice explains): how much is used, when it resets and what the thread will do at the
 * limit. Dismissed for the rest of that window.
 */
export function LimitWarning(props: { threadId: string; status: ThreadStatus | undefined }) {
  const { account, accounts } = useThreadAccount(props.threadId);
  const [policy] = useDaemonSetting("threads.limitPolicy");
  const [dismissed, setDismissed] = useState<string>();
  const now = useNow();
  if (!account || props.status?.state === "limited") return null;
  const limit = accountLimit(account);
  const window = limit.window;
  if (limit.level !== "near" || !window) return null;
  const key = `${account.id}:${window.id}:${window.resetsAt ?? ""}`;
  if (dismissed === key) return null;
  const target = accounts && migrationTarget(accounts, account.id);
  const name = accountName(account);
  const detail = [
    window.resetsAt === null ? undefined : `${formatResetCountdown(window.resetsAt, now)}.`,
    atLimitLine(policy, target ? accountName(target) : undefined),
  ];
  return (
    <section
      aria-label="Near the usage limit"
      className="fx-rise-in glass mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-2 pr-2 pl-3 text-ui"
    >
      <Icon icon={HourglassMediumIcon} size={16} className="text-status-needs-you" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {name} has used {window.usedPercent}% of its {window.label} window
        </p>
        <p className="text-sm text-muted-foreground">
          {detail.filter((part) => part !== undefined).join(" ")}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(key)}>
        Dismiss
      </Button>
    </section>
  );
}
