/* Accounts joined with the thread counts for Usage & accounts. */
import type { AccountThreadCounts, AccountView } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useAccountViews } from "@/lib/account-views.ts";
import { useAccountThreads } from "./account-threads-source.ts";

export { useAccountViews, useProviderAccountModels } from "@/lib/account-views.ts";
export type { QuotaWindowView as QuotaWindow } from "@ace/ui-core";
/** An account with its threads; `threads` is absent until the thread list has loaded. */
export type Account = AccountView & { threads?: AccountThreadCounts };
const noThreads: AccountThreadCounts = { running: 0, limited: 0, limitedIds: [] };

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
