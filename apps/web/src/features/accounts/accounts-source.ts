/*
 * Accounts and usage from the daemon: `accounts.list` (quota and availability per signed-in CLI
 * account) and `usage.series` / `usage.summary`, with each account's threads from the live list.
 */
import { UsageQuery, type UsageResult } from "@ace/protocol";
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
  usage: (from: string, to: string, groupBy: string) => ["usage", from, to, groupBy] as const,
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

/** One usage query, validated by the protocol schema before it is asked. */
export function useUsage(input: {
  from: string;
  to: string;
  groupBy: ("day" | "model" | "provider")[];
}) {
  return useDaemonQuery({
    queryKey: keys.usage(input.from, input.to, input.groupBy.join(",")),
    read: async (client, signal): Promise<UsageResult> => {
      const query = UsageQuery.parse({ ...input, equivalentApiCost: true, limit: 1000 });
      const reply = await client.request({ type: "usage.series", query }, { signal });
      return reply.result;
    },
  });
}
