import { apiKeyServiceLabel } from "@ace/ui-core";
import { useClient } from "@ace/client-react";
import type { ApiKeyUpstream, ProviderKind } from "@ace/protocol";
import { NativeAccountProvider } from "@ace/protocol/accounts";
import { useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
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
    } catch {
      throw new Error("Couldn't change this account. Check your connection and try again.");
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      refreshProviders(queryClient);
    }
  };
  return {
    rename: (instanceId: string, label: string) =>
      settle(client.request({ type: "accounts.rename", instanceId, label })),
    setDefault: (provider: NativeAccountProvider, instanceId: string) =>
      settle(client.request({ type: "accounts.setDefault", provider, instanceId })),
    /** Forget the account; its sign-in folder stays on disk. */
    remove: async (provider: NativeAccountProvider, instanceId: string) => {
      const reply = await settle(
        client.request({
          type: "provider.accounts.remove",
          provider,
          instanceId,
          confirm: true,
          deleteHome: false,
        }),
      );
      if (!reply.result.ok)
        throw new Error("Couldn't remove this account. Finish its running threads and try again.");
    },
  };
}

/** Runtime capability, never guessed from the provider name or a CLI version. */
export function useApiKeySupport(provider: ProviderKind) {
  return useDaemonQuery({
    queryKey: ["accounts", "api-key-support", provider],
    enabled: canAddAccounts(provider),
    read: async (client, signal) => {
      if (!canAddAccounts(provider)) return undefined;
      const reply = await client.request({ type: "provider.accounts.list", provider }, { signal });
      return reply.result.ok ? reply.result.apiKey : undefined;
    },
  });
}

export function apiKeyUpstreamLabel(upstream: z.infer<typeof ApiKeyUpstream>): string {
  return apiKeyServiceLabel("opencode", upstream);
}
