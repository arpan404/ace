import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { AccountKeyMark } from "@/features/account-management/index.ts";
import { ArrowRightIcon, PlayIcon } from "@phosphor-icons/react";
import { StatusLine } from "@/components/provider-tile.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { accountLimit, accountStatus } from "@ace/ui-core";
import { describeMove, useMoveThreads } from "./account-threads-source.ts";
import type { Account } from "./accounts-source.ts";
import { WindowBar } from "./window-bar.tsx";
import { QuotaReading } from "./quota-reading.tsx";
import { formatClock } from "./format.ts";

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
  const limit = accountLimit(account, now);
  const state = accountStatus(account, now);
  const resetsAt = limit.resetsAt;
  const limited = account.threads?.limitedIds ?? [];
  const waiting = limited.length;
  return (
    <article aria-label={`${account.providerLabel} ${account.label}`} className="border-b py-1">
      <div className="flex min-h-8 items-center gap-2 text-ui">
        <ProviderAccountIcon provider={account.provider} account={account} size={16} />
        <span className="min-w-0 flex-1 truncate font-medium">{account.label}</span>
        <AccountKeyMark method={account.authMethod} />
        <StatusLine tone={state.tone} text={state.text} />
      </div>
      {account.windows.length > 0 && <QuotaReading observedAt={account.quota.observedAt} />}
      {account.windows.length > 0 ? (
        <div className="grid gap-x-6 gap-y-2 py-2 text-sm sm:grid-cols-2">
          {account.windows.map((window) => (
            <WindowBar key={window.id} window={window} now={now} />
          ))}
        </div>
      ) : (
        account.signedIn && (
          <p className="mt-2 text-sm text-subtle-foreground">No limits reported yet</p>
        )
      )}
      {waiting > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 py-2 text-sm leading-[1.45] text-muted-foreground">
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
                  onSuccess: (result) => toast.add({ title: describeMove(result) }),
                  onError: (error) => toast.error({ title: error.message }),
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
