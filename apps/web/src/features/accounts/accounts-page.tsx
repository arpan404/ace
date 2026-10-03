import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { AccountCard } from "./account-card.tsx";
import { AddAccount } from "./add-account.tsx";
import { useAccounts, useRefreshAccounts, type Account } from "./accounts-source.ts";
import { SchedulingPolicySection } from "./scheduling-policy.tsx";
import { UsageSection } from "./usage-section.tsx";

function byProvider(accounts: readonly Account[]) {
  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    const key = `${account.providerLabel}\u0000${account.version ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  return [...groups.values()];
}

/** Usage & accounts: quota per account window, the run-out policy and usage over time. */
export function AccountsPage() {
  const accounts = useAccounts();
  const refresh = useRefreshAccounts();
  return (
    <Screen
      title="Usage & accounts"
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={accounts.isFetching}
          onClick={() => void refresh()}
        >
          <Icon icon={ArrowsClockwiseIcon} size={14} />
          Refresh
        </Button>
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[920px] px-8 pt-11 pb-20">
          <PageTitle
            title="Usage & accounts"
            lede="ace drives the CLIs you already have installed and signed in to. Usage comes from each provider; ace never stores credentials."
            actions={<AddAccount />}
          />
          {accounts.isError ? (
            <EmptyState
              icon={ChartBarIcon}
              title="Accounts unavailable"
              description={accounts.error.message}
            />
          ) : !accounts.data ? (
            <ListSkeleton label="accounts" shape="row" rows={4} className="mt-6" />
          ) : !accounts.data.length ? (
            <EmptyState
              icon={ChartBarIcon}
              title="No accounts found yet"
              description="Sign in to a provider CLI on this machine and refresh."
            />
          ) : (
            byProvider(accounts.data ?? []).map((group) => {
              const first = group[0];
              if (!first) return null;
              return (
                <section key={first.providerLabel} aria-label={first.providerLabel}>
                  <div className="mt-[30px] flex items-baseline gap-2">
                    <h2 className="text-md font-medium">{first.providerLabel}</h2>
                    {first.version && (
                      <small className="text-sm text-subtle-foreground">{first.version}</small>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    {group.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        accounts={accounts.data ?? []}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
          {accounts.data && <SchedulingPolicySection />}
          {accounts.data && <UsageSection />}
        </div>
      </div>
    </Screen>
  );
}
