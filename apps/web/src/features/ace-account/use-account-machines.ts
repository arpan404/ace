import { AceAccountError } from "@ace/client/ace-account";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAceAccount, useAceAccountStore } from "./account-context.tsx";
import { accountMachineLists, type AccountMachineLists } from "./account-machines.ts";

const empty: AccountMachineLists = { only: [], alsoOnAccount: new Set() };

/**
 * The machines on the person's ace account beside the ones this window lists, without
 * duplicates, and forgetting one. Nothing while signed out or without an account backend.
 */
export function useAccountMachines(listed: readonly { id: string }[]) {
  const store = useAceAccountStore();
  const { session } = useAceAccount();
  const token = session?.token;
  const queryClient = useQueryClient();
  const key = ["ace-account", "machines", store?.origin, token] as const;
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(store && token),
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof AceAccountError && error.status === 401) && count < 1,
    queryFn: async ({ signal }) => {
      if (!store || !token) return [];
      try {
        return await store.client.machines(
          token,
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        );
      } catch (error) {
        if (error instanceof AceAccountError && error.status === 401) await store.ended();
        throw error;
      }
    },
  });
  const forget = useMutation({
    mutationFn: async (hostId: string) => {
      if (!store || !token) throw new Error("Sign in to your ace account first.");
      await store.client
        .forgetMachine(token, hostId, AbortSignal.timeout(15_000))
        .catch((error: unknown) => {
          // Already gone from the account is what the person asked for.
          if (error instanceof AceAccountError && error.status === 404) return;
          throw new Error("Couldn't forget it. Try again.");
        });
    },
    onSuccess: (_, hostId) =>
      queryClient.setQueryData(key, (machines: { hostId: string }[] | undefined) =>
        machines?.filter((machine) => machine.hostId !== hostId),
      ),
  });
  const data = query.data;
  const lists = useMemo(() => (data ? accountMachineLists(listed, data) : empty), [listed, data]);
  return { ...lists, signedIn: Boolean(token), error: query.error, forget };
}
