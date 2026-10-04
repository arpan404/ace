import { PermissionClient, type ClientApi } from "@ace/client";
import { ProviderKind } from "@ace/protocol";
import {
  accountView,
  nativeProviders,
  providerStatuses,
  readJson,
  startingProvider,
  writeJson,
  type KeyValueStorage,
  type ProviderStatus,
} from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useExplicitDaemonSetting } from "@/lib/daemon-setting.ts";
import { useLayout } from "@/lib/layout.tsx";

/**
 * The native CLIs the daemon's discovery found installed. The daemon registers an adapter only
 * for a CLI discovery found, and answers `permissions.capabilities` from those adapters, without
 * starting the CLI: `provider_unavailable` means discovery didn't find it.
 * TODO(client-gaps): read discovery itself (version, the CLI's own login) once the daemon puts
 * it on the wire; today a CLI with no ace account counts as signed in.
 */
async function installedProviders(
  client: ClientApi,
  signal: AbortSignal | undefined,
): Promise<Set<ProviderKind>> {
  const permissions = new PermissionClient(client);
  const found = await Promise.all(
    nativeProviders.map(async ({ kind }) => {
      const reply = await permissions.getCapabilities(kind, undefined, signal ? { signal } : {});
      return reply.ok ? [kind] : [];
    }),
  );
  return new Set(found.flat());
}

/** Every provider with what discovery and `accounts.list` say about it, in discovery order. */
export async function readProviderStatuses(
  client: ClientApi,
  signal?: AbortSignal,
): Promise<ProviderStatus[]> {
  const [accounts, installed] = await Promise.all([
    client.request({ type: "accounts.list" }, signal ? { signal } : {}),
    installedProviders(client, signal),
  ]);
  return providerStatuses(installed, accounts.accounts.map(accountView));
}

export const providerStatusesKey = ["providers", "statuses"] as const;

/** The providers as the daemon describes them, for pickers; undefined until they've arrived. */
export function useProviderStatuses() {
  return useDaemonQuery({ queryKey: providerStatusesKey, read: readProviderStatuses });
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
