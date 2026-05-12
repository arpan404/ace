import {
  DEFAULT_PROVIDER_INSTANCE_ID,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerSettings,
} from "@ace/contracts";

export type ProviderSettingsByKind = ServerSettings["providers"];
export type ProviderSettingsFor<TProvider extends ProviderKind> = ProviderSettingsByKind[TProvider];
export type ProviderInstanceFor<TProvider extends ProviderKind> =
  ProviderSettingsFor<TProvider>["instances"][number];

export function resolveProviderInstanceId(
  providerInstanceId: string | null | undefined,
): ProviderInstanceId {
  const trimmed = providerInstanceId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROVIDER_INSTANCE_ID;
}

export function isDefaultProviderInstanceId(
  providerInstanceId: string | null | undefined,
): boolean {
  return resolveProviderInstanceId(providerInstanceId) === DEFAULT_PROVIDER_INSTANCE_ID;
}

export function getProviderInstances<TProvider extends ProviderKind>(
  settings: Pick<ServerSettings, "providers">,
  provider: TProvider,
): ReadonlyArray<ProviderInstanceFor<TProvider>> {
  return settings.providers[provider].instances;
}

export function findProviderInstance<TProvider extends ProviderKind>(
  settings: Pick<ServerSettings, "providers">,
  provider: TProvider,
  providerInstanceId: string | null | undefined,
): ProviderInstanceFor<TProvider> | undefined {
  const resolvedId = resolveProviderInstanceId(providerInstanceId);
  if (resolvedId === DEFAULT_PROVIDER_INSTANCE_ID) {
    return undefined;
  }
  return settings.providers[provider].instances.find((instance) => instance.id === resolvedId);
}

export function resolveProviderSettings<TProvider extends ProviderKind>(
  settings: Pick<ServerSettings, "providers">,
  provider: TProvider,
  providerInstanceId: string | null | undefined,
): ProviderSettingsFor<TProvider> {
  const providerSettings = settings.providers[provider];
  const instance = findProviderInstance(settings, provider, providerInstanceId);
  if (!instance) {
    return providerSettings;
  }

  const merged = {
    ...providerSettings,
    ...instance,
    enabled: instance.enabled,
    instances: providerSettings.instances,
  };
  return merged as ProviderSettingsFor<TProvider>;
}

export function resolveProviderInstanceLabel<TProvider extends ProviderKind>(
  settings: Pick<ServerSettings, "providers">,
  provider: TProvider,
  providerInstanceId: string | null | undefined,
): string {
  const resolvedId = resolveProviderInstanceId(providerInstanceId);
  if (resolvedId === DEFAULT_PROVIDER_INSTANCE_ID) {
    return "Default";
  }
  return (
    findProviderInstance(settings, provider, resolvedId)?.label ??
    resolvedId
      .split(/[-_\s]+/g)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function buildProviderInstanceId(provider: ProviderKind, label: string): ProviderInstanceId {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${provider}-${slug || "instance"}`;
}
