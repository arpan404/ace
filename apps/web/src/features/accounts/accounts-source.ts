/*
 * Accounts from the daemon: `accounts.list` (quota and availability per signed-in CLI account),
 * with each account's threads from the live list. Usage over time is `usage-source.ts`.
 */
import {
  accountView,
  providerAccountModel,
  type AccountThreadCounts,
  type AccountView,
} from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useProviderReadiness } from "@/lib/provider-readiness.ts";
import { useCatalogSignals } from "@/lib/provider-signals.ts";
import { useNow } from "@/lib/time.ts";
import type { ProviderKind } from "@ace/protocol";
import { useAccountThreads } from "./account-threads-source.ts";

export type { QuotaWindowView as QuotaWindow } from "@ace/ui-core";
/** An account with its threads; `threads` is absent until the thread list has loaded. */
export type Account = AccountView & { threads?: AccountThreadCounts };

const noThreads: AccountThreadCounts = { running: 0, limited: 0, limitedIds: [] };

const keys = {
  accounts: ["accounts", "list"] as const,
};

/**
 * Every account the daemon's CLIs are signed in to, as view models. Committed limit updates replace the shared read through `usage.limits_changed`.
 * An optional `refreshMs` also checks while the page is visible; every reader shares one request.
 */
function useRawAccountViews(options: { enabled?: boolean; refreshMs?: number } = {}) {
  return useDaemonQuery({
    queryKey: keys.accounts,
    enabled: options.enabled ?? true,
    ...(options.refreshMs ? { refetchInterval: options.refreshMs } : {}),
    read: async (client, signal): Promise<AccountView[]> => {
      const reply = await client.request({ type: "accounts.list" }, { signal });
      return reply.accounts.map(accountView);
    },
  });
}

/** One reconciliation shared by account pages, provider pages and pickers. */
export function useProviderAccountModels(options: { enabled?: boolean; refreshMs?: number } = {}) {
  const accounts = useRawAccountViews(options);
  const readiness = useProviderReadiness();
  const signals = useCatalogSignals();
  const now = useNow();
  const model = (provider: ProviderKind, acpAgentId?: string) =>
    providerAccountModel({
      provider,
      acpAgentId,
      accounts: accounts.data,
      now,
      row: readiness.data?.find((row) => row.provider === provider),
      catalog: signals(
        provider,
        readiness.data?.find((row) => row.provider === provider)?.instanceId,
      ),
    });
  return { accounts, model };
}

export function useAccountViews(options: { enabled?: boolean; refreshMs?: number } = {}) {
  const { accounts, model } = useProviderAccountModels(options);
  const groups = new Map<string, { provider: ProviderKind; acpAgentId?: string | undefined }>();
  for (const account of accounts.data ?? [])
    groups.set(`${account.provider}:${account.acpAgentId ?? ""}`, account);
  const models = [...groups.values()].map((group) => model(group.provider, group.acpAgentId));
  const data =
    accounts.data && models.every((entry) => entry.loaded)
      ? models.flatMap((entry) => entry.accounts)
      : undefined;
  return { ...accounts, data };
}

/** Accounts with the threads running on each, as the accounts screen shows them. */
export function useAccounts() {
  const accounts = useAccountViews();
  const threads = useAccountThreads();
  const data = accounts.data?.map((account): Account =>
    threads ? { ...account, threads: threads.get(account.id) ?? noThreads } : account,
  );
  return { ...accounts, data };
}

/** Re-read accounts and quota from the providers. */
export function useRefreshAccounts() {
  const queries = useQueryClient();
  return () => queries.invalidateQueries({ queryKey: ["accounts"] });
}
