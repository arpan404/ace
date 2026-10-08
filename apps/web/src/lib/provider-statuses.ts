import { type ClientApi } from "@ace/client";
import { ProviderKind } from "@ace/protocol";
import {
  accountView,
  providerStatuses,
  providerAccountState,
  readJson,
  startingProvider,
  writeJson,
  type KeyValueStorage,
  type ProviderStatus,
} from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useExplicitDaemonSetting } from "@/lib/daemon-setting.ts";
import { useModelCatalogState } from "@/lib/model-catalog.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import { useProvidersWatch } from "@/lib/provider-readiness.ts";

/** Read runtime discovery rather than inferring authentication from installed adapters. */
export async function readProviderStatuses(
  client: ClientApi,
  signal?: AbortSignal,
): Promise<ProviderStatus[]> {
  const [accounts, discovery] = await Promise.all([
    client.request({ type: "accounts.list" }, signal ? { signal } : {}),
    client.request({ type: "providers.request", operation: "list" }, signal ? { signal } : {}),
  ]);
  if (!discovery.result.ok) throw new Error("Provider discovery unavailable");
  const rows = discovery.result.providers;
  const installed = new Set(
    rows.filter((row) => row.installed === true).map((row) => row.provider),
  );
  const views = accounts.accounts.map(accountView);
  const now = Date.now();
  return providerStatuses(installed, views, rows, now);
}

export const providerStatusesKey = ["providers", "statuses"] as const;

/**
 * The providers as the daemon describes them, for pickers; undefined until they've arrived.
 * A sign-in finished anywhere (`providers.changed`) reads them again.
 */
export function useProviderStatuses() {
  useProvidersWatch();
  const query = useDaemonQuery({ queryKey: providerStatusesKey, read: readProviderStatuses });
  const { model } = useProviderAccountModels();
  const catalogState = useModelCatalogState();
  const reconciled = query.data?.map((status) => ({
    status,
    model: model(status.provider, status.acpAgentId),
  }));
  const loaded = catalogState !== "loading" && reconciled?.every((entry) => entry.model.loaded);
  return {
    ...query,
    data: loaded
      ? reconciled?.map(({ status, model }) => ({
          ...status,
          state: providerAccountState(model),
          accounts: model.accounts,
        }))
      : undefined,
  };
}

const none: readonly ProviderStatus[] = [];
const lastProviderKey = "ace.newThread.lastProvider";

/** The provider of the last thread the person started on this device. */
export function lastProvider(storage: KeyValueStorage | undefined): ProviderKind | undefined {
  return readJson(storage, lastProviderKey, ProviderKind.optional(), undefined);
}

export function rememberProvider(storage: KeyValueStorage | undefined, provider: ProviderKind) {
  writeJson(storage, lastProviderKey, provider);
}

/**
 * The provider a new thread starts on (`startingProvider` in `@ace/ui-core`): the Settings
 * default when the person set one, else the one they used last, else the first ready provider.
 * `loaded` is false until the setting and the providers have arrived.
 */
export function useStartingProvider(): {
  provider: ProviderKind | undefined;
  /** The Settings default, when the person set one. */
  chosen: ProviderKind | undefined;
  loaded: boolean;
} {
  const { storage } = useLayout();
  const setting = useExplicitDaemonSetting("providers.default");
  const statuses = useProviderStatuses();
  // Unreadable providers leave only the person's own choices to go on.
  const providers = statuses.data ?? (statuses.isError ? none : undefined);
  const lastUsed = lastProvider(storage);
  const provider = providers
    ? statuses.isError
      ? (setting.value ?? lastUsed)
      : startingProvider({ chosen: setting.value, lastUsed, providers })
    : undefined;
  return { provider, chosen: setting.value, loaded: setting.loaded && providers !== undefined };
}
