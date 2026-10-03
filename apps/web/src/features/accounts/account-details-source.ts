// TODO(client-gaps): feat/client-protocol-gaps. `accounts.list` carries no plan, default
// account or per-account thread counts, and there is no run-out policy setting or command to move
// an exhausted account's threads. Against a real daemon these read as absent and the controls
// stay hidden; in fake mode they come from the fake backend. Delete this file once the daemon
// reports them.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";

export interface AccountDetails {
  plan: string;
  isDefault: boolean;
  runningThreads: number;
  pausedThreads: number;
}
export interface SchedulingPolicy {
  onExhausted: "switch" | "pause" | "ask";
  keepHeadroom: boolean;
}

const keys = {
  details: ["accounts", "details"] as const,
  policy: ["accounts", "policy"] as const,
};

async function loaded(backend: Promise<FakeBackend> | null): Promise<FakeBackend> {
  if (!backend) throw new UnavailableError("Moving threads between accounts");
  return backend;
}

/** Plan, default and thread counts by account id; empty against a real daemon. */
export function useAccountDetails() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: keys.details,
    queryFn: async (): Promise<ReadonlyMap<string, AccountDetails>> => {
      if (!backend) return new Map();
      const { accounts } = await backend;
      return new Map(
        accounts.map((a) => [
          a.id,
          {
            plan: a.plan,
            isDefault: a.isDefault,
            runningThreads: a.runningThreads,
            pausedThreads: a.pausedThreads,
          },
        ]),
      );
    },
  });
}

/** The run-out policy, or null when the daemon has no such setting yet. */
export function usePolicy() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: keys.policy,
    queryFn: async (): Promise<SchedulingPolicy | null> =>
      backend ? (await backend).policy : null,
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
    onSettled: () => queries.invalidateQueries({ queryKey: keys.details }),
  });
}
