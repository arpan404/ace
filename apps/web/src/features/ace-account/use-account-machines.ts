import { AceAccountError } from "@ace/client/ace-account";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useAceAccount, useAceAccountStore } from "./account-context.tsx";
import { accountMachineLists, type AccountMachineLists } from "./account-machines.ts";
import { useSpace } from "./space-context.tsx";

const empty: AccountMachineLists = { only: [], alsoOnAccount: new Set() };

/**
 * The machines on the person's ace account beside the ones this window lists, without
 * duplicates, and forgetting one. Nothing while signed out or without an account backend. In an
 * organization's space they are its hosts; in Personal, the person's own machines, never an org
 * host (ADR 0206 §1.5). The list is kept per space, so switching never shows another's.
 */
export function useAccountMachines(listed: readonly { id: string }[]) {
  // This window's own machine, when it is one on the account, lists as the window's machine.
  const own = useDaemonConnection().account?.hostId;
  const shown = useMemo(() => (own ? [...listed, { id: own }] : listed), [listed, own]);
  const store = useAceAccountStore();
  const { session } = useAceAccount();
  const token = session?.token;
  const queryClient = useQueryClient();
  const space = useSpace().shown?.id;
  const key = ["ace-account", "machines", store?.origin, token, space] as const;
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(store && token && space),
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof AceAccountError && error.status === 401) && count < 1,
    queryFn: async ({ signal }) => {
      if (!store || !token || !space) return [];
      const within = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      try {
        return store.orgs
          ? await store.orgs.machines(token, space, within)
          : await store.client.machines(token, within);
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
  const lists = useMemo(() => (data ? accountMachineLists(shown, data) : empty), [shown, data]);
  return {
    ...lists,
    signedIn: Boolean(token),
    /** The account's list is on its way. */
    loading: query.isLoading,
    error: query.error,
    forget,
  };
}
