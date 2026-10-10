import { accountView, providerAccountModel, type AccountView } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";
import { useDaemonQuery } from "./daemon-query.ts";
import { useProviderReadiness } from "./provider-readiness.ts";
import { useCatalogSignals } from "./provider-signals.ts";
import { useNow } from "./time.ts";

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
      catalogForAccount: (id) => signals(provider, id),
      readinessFailed: readiness.isFetched && readiness.data === undefined,
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
