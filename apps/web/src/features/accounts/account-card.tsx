import { accountLimit, liveWindows } from "@ace/ui-core";
import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useNow } from "@/lib/time.ts";
import type { Account } from "./accounts-source.ts";
import { CompactWindow } from "./window-bar.tsx";
import { formatResets } from "./format.ts";

/** Usage is read-only; running thread counts belong in the row's tooltip. */
export function AccountCard(props: { account: Account }) {
  const { account } = props;
  const now = useNow();
  const windows = liveWindows(account, now);
  const reset =
    accountLimit(account, now).resetsAt ??
    windows.find((window) => window.resetsAt !== null)?.resetsAt;
  const threads = account.threads;
  const tip = [
    `${threads?.running ?? 0} running threads`,
    `${threads?.limited ?? 0} threads at a limit`,
    account.quota.observedAt
      ? `Last reported ${new Date(account.quota.observedAt).toLocaleString()}`
      : "Not reported yet",
  ].join(" · ");
  return (
    <article
      aria-label={`${account.providerLabel} ${account.label}`}
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm"
    >
      <AccountBadge account={account} />
      <Tip label={tip}>
        <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-xs focus-ring">
          {account.providerLabel} · {account.label}
        </span>
      </Tip>
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 pl-8 sm:w-auto sm:pl-0">
        {account.windows.length ? (
          account.windows.map((window) => (
            <CompactWindow key={window.id} window={window} now={now} />
          ))
        ) : (
          <span className="text-xs text-subtle-foreground">
            {account.quota.auth === "logged_in" &&
            account.quota.observedAt > 0 &&
            ["opencode", "pi"].includes(account.provider)
              ? "No limits"
              : "Not reported yet"}
          </span>
        )}
        {reset !== undefined && reset !== null && (
          <span className="text-xs text-subtle-foreground">{formatResets(reset, now)}</span>
        )}
        {accountLimit(account, now).level === "reached" && (
          <span className="text-xs text-status-failed">Limit reached</span>
        )}
      </div>
    </article>
  );
}
