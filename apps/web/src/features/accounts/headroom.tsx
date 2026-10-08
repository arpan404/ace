import { providerHeadroom, type AccountView, type ProviderHeadroom } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useNow } from "@/lib/time.ts";
import { formatResetCountdown } from "./format.ts";

/** "1 of 2 accounts can work · Most room: Personal, 62% of 5-hour left · Team resets 23:52 · in 1h 27m". */
function headroomLine(row: ProviderHeadroom, now: number): string {
  const parts = [
    `${row.available} of ${row.accounts} ${row.accounts === 1 ? "account" : "accounts"} can work`,
  ];
  if (row.unreported) parts.push(`${row.unreported} with no limits reported`);
  if (row.best && row.accounts > 1)
    parts.push(
      `Most room: ${row.best.account.label}, ${row.best.left}% of ${row.best.window.label} left`,
    );
  else if (row.best) parts.push(`${row.best.left}% of ${row.best.window.label} left`);
  if (row.nextReset)
    parts.push(`${row.nextReset.account.label} ${formatResetCountdown(row.nextReset.at, now)}`);
  return parts.join(" · ");
}

/**
 * Headroom now, per provider: how many of its accounts can take work, which has the most room in
 * its tightest window, and when the next one at a limit frees up. Providers that report no
 * windows are left out: there is nothing to compare.
 */
export function Headroom(props: { accounts: readonly AccountView[] }) {
  const now = useNow();
  const rows = providerHeadroom(props.accounts, now);
  if (!rows.length) return null;
  return (
    <>
      <p className="mt-4 text-xs font-medium text-subtle-foreground">Headroom now</p>
      <ul aria-label="Headroom now" className="mt-2">
        {rows.map((row) => (
          <li
            key={row.providerLabel}
            className="flex items-center gap-2.5 border-t py-2.5 text-sm last:border-b"
          >
            <ProviderIcon
              provider={row.provider}
              acpAgentId={row.acpAgentId}
              size={16}
              decorative
            />
            <span className="w-28 shrink-0 font-medium">{row.providerLabel}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">{headroomLine(row, now)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
