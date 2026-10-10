import { accountLimit } from "@ace/ui-core";
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
  const limit = accountLimit(account, now);
  const reset = limit.level === "reached" ? limit.resetsAt : limit.window?.resetsAt;
  const threads = account.threads;
  const tip = [
    `${account.providerLabel} · ${account.label}`,
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
        <span
          tabIndex={0}
          style={{ minWidth: 160 }}
          className="flex-1 truncate rounded-xs focus-ring"
        >
          {account.providerLabel} · {account.label}
        </span>
      </Tip>
      <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-1 pl-8">
        {account.windows.length ? (
          account.windows.map((window) => (
            <CompactWindow key={window.id} window={window} now={now} />
          ))
        ) : (
          <span className="text-xs text-subtle-foreground">
            {limit.level !== "reached" &&
            account.quota.auth === "logged_in" &&
            account.quota.observedAt > 0 &&
            ["opencode", "pi"].includes(account.provider)
              ? "No limits"
              : "Not reported yet"}
          </span>
        )}
        {reset !== undefined && reset !== null && (
          <span className="text-xs text-subtle-foreground">{formatResets(reset, now)}</span>
        )}
        {limit.level === "reached" && (
          <span className="text-xs text-status-failed">Limit reached</span>
        )}
      </div>
    </article>
  );
}
