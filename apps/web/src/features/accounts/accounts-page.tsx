import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { accountLimit, liveWindows, nearLimitPercent } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useNow } from "@/lib/time.ts";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { AccountCard } from "./account-card.tsx";
import { useAccounts, useRefreshAccounts } from "./accounts-source.ts";
import { UsageSection } from "./usage-section.tsx";

export function AccountsPage() {
  const accounts = useAccounts();
  const refresh = useRefreshAccounts();
  const now = useNow();
  const closest = (accounts.data ?? []).filter(
    (account) =>
      accountLimit(account, now).level === "reached" ||
      liveWindows(account, now).some((window) => window.usedPercent >= nearLimitPercent),
  );
  const ids = new Set(closest.map((account) => account.id));
  const groups = [
    { name: "Closest to a limit", rows: closest },
    {
      name: "Everything else",
      rows: (accounts.data ?? []).filter((account) => !ids.has(account.id)),
    },
  ];
  return (
    <Screen title="Usage">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-230 px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <PageTitle
                title="Usage"
                lede={
                  <>
                    Limits as last reported by each provider.{" "}
                    <Link
                      to="/settings/providers"
                      className="hover:text-foreground hover:underline"
                    >
                      Manage accounts in Settings › Providers.
                    </Link>
                  </>
                }
              />
            </div>
            <IconButton
              icon={ArrowsClockwiseIcon}
              label="Refresh"
              size="sm"
              disabled={accounts.isFetching}
              onClick={() => void refresh()}
            />
          </div>
          {accounts.isError ? (
            <EmptyState
              icon={ChartBarIcon}
              title="Couldn't load usage"
              description={describeDaemonError(daemonErrorCode(accounts.error))}
              action={
                <Button size="sm" onClick={() => void accounts.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : !accounts.data ? (
            <ListSkeleton label="usage" shape="row" rows={6} className="mt-7" />
          ) : !accounts.data.length ? (
            <EmptyState
              icon={ChartBarIcon}
              title="No accounts found yet"
              description="Add an account in Settings › Providers to see its usage."
            />
          ) : (
            groups
              .filter((group) => group.rows.length)
              .map((group) => (
                <section key={group.name} aria-label={group.name} className="mt-7">
                  <h2 className="mb-2 text-sm font-medium text-muted-foreground">{group.name}</h2>
                  {group.rows.map((account) => (
                    <AccountCard key={account.id} account={account} />
                  ))}
                </section>
              ))
          )}
          {accounts.data && <UsageSection />}
        </div>
      </div>
    </Screen>
  );
}
