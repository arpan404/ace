import { accountLimit } from "@ace/ui-core";
import { StatusLabel } from "@/components/status-label.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useNow } from "@/lib/time.ts";
import type { Account } from "./accounts-source.ts";
import { CompactWindow } from "./window-bar.tsx";
import { AccountIdentity } from "./account-identity.tsx";
import { formatResets } from "./format.ts";

/** Usage is read-only; every row reserves the same meter, reset and status columns. */
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
  const status =
    limit.level === "reached"
      ? "Limit reached"
      : account.windows.length
        ? undefined
        : account.quota.auth === "logged_in" &&
            account.quota.observedAt > 0 &&
            ["opencode", "pi"].includes(account.provider)
          ? "No limits"
          : "Not reported yet";
  // Weekly stays in the second slot even without a short window. Daily uses the first.
  const windows = [
    { id: "short", rows: account.windows.filter((window) => !window.label.startsWith("Weekly")) },
    { id: "weekly", rows: account.windows.filter((window) => window.label.startsWith("Weekly")) },
  ];
  return (
    <article
      aria-label={`${account.providerLabel} ${account.label}`}
      className="usage-limit-row grid min-h-9 items-center gap-2 py-1 text-sm"
    >
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <AccountIdentity account={account} tooltip={tip} />
      </div>
      {windows.map((slot) => (
        <div key={slot.id} className={account.windows.length ? "grid gap-1" : "hidden xl:block"}>
          {slot.rows.map((window) => (
            <CompactWindow key={window.id} window={window} now={now} />
          ))}
        </div>
      ))}
      <div className={reset != null ? "text-xs text-subtle-foreground" : "hidden xl:block"}>
        {reset != null && (
          <Tip label={formatResets(reset, now)}>
            <span tabIndex={0} className="rounded-xs focus-ring">
              {formatResets(reset, now)}
            </span>
          </Tip>
        )}
      </div>
      <div
        className={account.windows.length ? "text-right" : "col-span-2 text-right xl:col-span-1"}
      >
        {status && (
          <StatusLabel tone={limit.level === "reached" ? "failed" : "idle"} label={status} />
        )}
      </div>
    </article>
  );
}
