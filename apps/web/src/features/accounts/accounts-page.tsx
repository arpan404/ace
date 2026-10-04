import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
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

/** The loaded layout's shape: a provider heading over two account cards, each with two rings. */
function AccountsSkeleton() {
  return (
    <LoadingRegion label="accounts">
      <Skeleton className="mt-[30px] h-3.5 w-28" />
      <div className="mt-3 grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {[0, 1].map((card) => {
          const style = { animationDelay: `${card * 90}ms` };
          return (
            <div
              key={card}
              className="rounded-lg px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)]"
            >
              <Skeleton className="h-3.5 w-24" style={style} />
              <div className="mt-3.5 flex gap-x-[26px]">
                {[0, 1].map((ring) => (
                  <div key={ring} className="flex items-center gap-2.5">
                    <Skeleton className="size-11 rounded-full" style={style} />
                    <span className="flex flex-col gap-1.5">
                      <Skeleton className="h-3 w-14" style={style} />
                      <Skeleton className="h-2.5 w-20" style={style} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </LoadingRegion>
  );
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
              description={describeDaemonError(daemonErrorCode(accounts.error))}
              action={
                <Button size="sm" onClick={() => void accounts.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : !accounts.data ? (
            <AccountsSkeleton />
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
                  <div className="mt-[30px] flex items-center gap-2">
                    <ProviderIcon
                      provider={first.provider}
                      acpAgentId={first.acpAgentId}
                      size={16}
                      decorative
                    />
                    <h2 className="text-md font-medium">{first.providerLabel}</h2>
                    {first.version && (
                      <small className="text-sm text-subtle-foreground">{first.version}</small>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
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
