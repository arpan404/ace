import { AddAccountInline } from "@/features/account-management/index.ts";
import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { AccountCard } from "./account-card.tsx";
import { Link } from "@tanstack/react-router";
import { useAccounts, useRefreshAccounts, type Account } from "./accounts-source.ts";
import { SchedulingPolicySection } from "./scheduling-policy.tsx";
import { UsageSection } from "./usage-section.tsx";

function byProvider(accounts: readonly Account[]) {
  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    const key = `${account.provider}\u0000${account.acpAgentId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  return [...groups.entries()];
}

/** Compact rows while account status is being read. */
function AccountsSkeleton() {
  return <ListSkeleton label="accounts" shape="row" rows={6} className="mt-7" />;
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
          />
          <p className="mt-3 text-xs text-subtle-foreground">
            Usage updates when a provider reports a new reading. Refresh reloads the last reported
            reading.
          </p>
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
            byProvider(accounts.data ?? []).map(([key, group]) => {
              const first = group[0];
              if (!first) return null;
              const version = group.find((account) => account.version)?.version;
              return (
                <section key={key} aria-label={first.providerLabel}>
                  <div className="mt-[30px] flex items-center gap-2">
                    <ProviderIcon
                      provider={first.provider}
                      acpAgentId={first.acpAgentId}
                      size={16}
                      decorative
                    />
                    <h2 className="text-md font-medium">
                      <Link
                        to="/settings/providers/$provider"
                        params={{
                          provider:
                            first.provider === "acp"
                              ? `acp:${first.providerLabel}`
                              : first.provider,
                        }}
                      >
                        {first.providerLabel}
                      </Link>
                    </h2>
                    {version && <small className="text-sm text-subtle-foreground">{version}</small>}
                  </div>
                  <div className="mt-2">
                    {group.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        accounts={accounts.data ?? []}
                      />
                    ))}
                    <AddAccountInline provider={first.provider} />
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
