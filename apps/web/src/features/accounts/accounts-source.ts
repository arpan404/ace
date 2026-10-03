// TODO(train-2): wire to protocol when merged
/*
 * Accounts (#25: accounts.list / accounts.migrate) and usage analytics (usage.series /
 * usage.summary). The usage messages are on the wire but @ace/client has no request for
 * them yet, and the accounts protocol is not on this branch, so both read from the fake
 * backend in fake mode. Usage already speaks the protocol's UsageQuery and UsageResult.
 */
import { UsageQuery, type UsageResult } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number;
}
export interface Account {
  id: string;
  provider: "claude" | "codex" | "opencode" | "cursor" | "acp";
  providerLabel: string;
  cliVersion: string;
  label: string;
  plan: string;
  isDefault: boolean;
  availability: "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";
  windows: readonly QuotaWindow[];
  runningThreads: number;
  pausedThreads: number;
}
export interface SchedulingPolicy {
  onExhausted: "switch" | "pause" | "ask";
  keepHeadroom: boolean;
}

async function loaded(backend: Promise<FakeBackend> | null): Promise<FakeBackend> {
  if (!backend) throw new UnavailableError("Accounts and usage");
  return backend;
}

const keys = {
  accounts: ["accounts", "list"] as const,
  policy: ["accounts", "policy"] as const,
  usage: (from: string, to: string, groupBy: string) => ["usage", from, to, groupBy] as const,
};

export function useAccounts() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: keys.accounts,
    // A copy, as a wire response would be: later fake changes show only after a refetch.
    queryFn: async (): Promise<readonly Account[]> =>
      structuredClone((await loaded(backend)).accounts),
  });
}

export function usePolicy() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: keys.policy,
    queryFn: async (): Promise<SchedulingPolicy> => (await loaded(backend)).policy,
  });
}

export function useSetPolicy() {
  const backend = useFakeBackend();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (next: Partial<SchedulingPolicy>) => {
      const fake = await loaded(backend);
      fake.policy = { ...fake.policy, ...next };
      return fake.policy;
    },
    onSuccess: (policy) => queries.setQueryData(keys.policy, policy),
  });
}

/** Moves an exhausted account's threads to the same provider's account with most headroom. */
export function useMoveThreads() {
  const backend = useFakeBackend();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string): Promise<{ moved: number; to: string }> => {
      const fake = await loaded(backend);
      const result = fake.fake.moveThreads(fake.accounts, accountId);
      if ("error" in result)
        throw new Error(
          result.error === "no_account_with_headroom"
            ? "No other account for this provider has headroom."
            : "There are no threads to move.",
        );
      fake.accounts = result.accounts;
      return { moved: result.moved, to: result.to.label };
    },
    onSettled: () => queries.invalidateQueries({ queryKey: keys.accounts }),
  });
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
  const backend = useFakeBackend();
  return useQuery({
    queryKey: keys.usage(input.from, input.to, input.groupBy.join(",")),
    queryFn: async (): Promise<UsageResult> => {
      const query = UsageQuery.parse({ ...input, equivalentApiCost: true, limit: 1000 });
      return (await loaded(backend)).fake.usageReport(query);
    },
  });
}
