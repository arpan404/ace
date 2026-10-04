/*
 * Accounts from the daemon: `accounts.list` (quota and availability per signed-in CLI account),
 * with each account's threads from the live list. Usage over time is `usage-source.ts`.
 */
import { accountView, type AccountThreadCounts, type AccountView } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useAccountThreads } from "./account-threads-source.ts";

export type { QuotaWindowView as QuotaWindow } from "@ace/ui-core";
/** An account with its threads; `threads` is absent until the thread list has loaded. */
export type Account = AccountView & { threads?: AccountThreadCounts };

const noThreads: AccountThreadCounts = { running: 0, limited: 0, limitedIds: [] };

const keys = {
  accounts: ["accounts", "list"] as const,
};

/** Every account the daemon's CLIs are signed in to, as view models. */
export function useAccountViews() {
  return useDaemonQuery({
    queryKey: keys.accounts,
    read: async (client, signal): Promise<AccountView[]> => {
      const reply = await client.request({ type: "accounts.list" }, { signal });
      return reply.accounts.map(accountView);
    },
  });
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
