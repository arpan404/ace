import { accountLimit } from "@ace/ui-core";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useNow } from "@/lib/time.ts";
import type { Account } from "./accounts-source.ts";
import { CompactWindow } from "./window-bar.tsx";
import { AccountIdentity } from "./account-identity.tsx";
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
      className="grid min-h-9 grid-cols-1 items-center gap-2 rounded-xs py-1 text-sm hover:bg-accent sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <AccountIdentity account={account} tooltip={tip} />
      <div
        className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-1 pl-12 sm:pl-0"
        style={{ width: 464 }}
      >
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
        {(reset !== undefined && reset !== null) || limit.level === "reached" ? (
          <Tip
            label={
              limit.level === "reached"
                ? `Limit reached · ${reset != null ? formatResets(reset, now) : "Reset time not reported"}`
                : formatResets(reset ?? now, now)
            }
          >
            <span
              tabIndex={0}
              className={
                limit.level === "reached"
                  ? "rounded-xs text-xs text-status-failed focus-ring sm:ml-auto"
                  : "rounded-xs text-xs text-subtle-foreground focus-ring sm:ml-auto"
              }
            >
              {reset != null ? formatResets(reset, now) : "Limit reached"}
            </span>
          </Tip>
        ) : null}
      </div>
    </article>
  );
}
