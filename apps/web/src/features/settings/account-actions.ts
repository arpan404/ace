import { useClient } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { NativeAccountProvider } from "@ace/protocol/accounts";
import { useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { refreshProviders } from "@/lib/provider-readiness.ts";

/*
 * Managing a provider's accounts from its page, over the daemon's account service
 * (`accounts.add/rename/setDefault/remove`, scope `accounts`). Adding one makes a separate home
 * for the CLI; its sign-in then runs like any other (`provider.login.start` with `instance`).
 * Every change reads accounts and providers again.
 */

type NativeAccountProvider = z.infer<typeof NativeAccountProvider>;

/** Providers ace can keep more than one account of. */
export function canAddAccounts(provider: ProviderKind): provider is NativeAccountProvider {
  return NativeAccountProvider.safeParse(provider).success;
}

export function useAccountActions() {
  const client = useClient();
  const queryClient = useQueryClient();
  /** Whatever happened, accounts and providers are read again. */
  const settle = async <T>(request: Promise<T>): Promise<T> => {
    try {
      return await request;
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      refreshProviders(queryClient);
    }
  };
  return {
    /** A new account for `provider`, named `label`; its id, to sign it in. */
    add: async (provider: NativeAccountProvider, label: string): Promise<string> => {
      const reply = await settle(client.request({ type: "accounts.add", provider, label }));
      if (!reply.account) throw new Error("The daemon didn't add the account.");
      return reply.account.id;
    },
    rename: (instanceId: string, label: string) =>
      settle(client.request({ type: "accounts.rename", instanceId, label })),
    setDefault: (provider: NativeAccountProvider, instanceId: string) =>
      settle(client.request({ type: "accounts.setDefault", provider, instanceId })),
    /** Forget the account; its sign-in folder stays on disk. */
    remove: (instanceId: string) =>
      settle(client.request({ type: "accounts.remove", instanceId, deleteHome: false })),
  };
}
